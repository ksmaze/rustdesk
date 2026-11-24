// rustdesk-web-gateway serves the RustDesk web client and bridges its WebSocket to a RustDesk
// session stream: a SealDesk host's tailcat address, or a stock host's direct IP access port
// (TCP 21118), optionally over an in-process WireGuard tunnel. Browsers cannot open UDP or raw
// TCP sockets, so the tunnel ends here.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	directPath  = "/ws/direct/"
	tailcatPath = "/ws/tailcat/"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "wg-pair" {
		if err := wgPair(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	listen := flag.String("listen", ":"+envOr("RUSTDESK_PORT", "5000"), "HTTP listen address")
	root := flag.String("root", envOr("RUSTDESK_WEB_ROOT", "/app/web"), "web client files")
	flag.Parse()

	verbose := strings.EqualFold(os.Getenv("GATEWAY_VERBOSE"), "true")
	d, err := newDialer(verbose)
	if err != nil {
		log.Fatal(err)
	}
	allow, err := parseAllowList(os.Getenv("GATEWAY_ALLOW_CIDRS"), d.DefaultAllowed())
	if err != nil {
		log.Fatal(err)
	}
	ports, err := parsePorts(envOr("GATEWAY_ALLOW_PORTS", "21118"))
	if err != nil {
		log.Fatal(err)
	}
	tc, err := newTailcatDialer()
	if err != nil {
		log.Fatal(err)
	}
	g := &gateway{dialer: d, allow: allow, ports: ports, tailcat: tc}
	mux := http.NewServeMux()
	mux.Handle(directPath, g)
	mux.Handle(tailcatPath, g)
	mux.Handle("/", http.FileServer(http.Dir(*root)))
	log.Printf("Serving %s on %s, direct connections via %s to %v ports %v",
		*root, *listen, d.Name(), describeAllow(allow), ports)
	log.Fatal(http.ListenAndServe(*listen, mux))
}

func newDialer(verbose bool) (dialer, error) {
	wgConf := os.Getenv("WG_CONFIG")
	if wgConf == "" {
		if _, err := os.Stat("/etc/wireguard/wg0.conf"); err == nil {
			wgConf = "/etc/wireguard/wg0.conf"
		}
	}
	if wgConf != "" {
		return newWgDialer(wgConf, verbose)
	}
	return &systemDialer{net.Dialer{Timeout: 10 * time.Second}}, nil
}

// parseAllowList takes comma separated CIDRs; "any" allows every address.
func parseAllowList(value string, def []netip.Prefix) ([]netip.Prefix, error) {
	if value == "" {
		return def, nil
	}
	if strings.EqualFold(value, "any") {
		return mustPrefixes("0.0.0.0/0", "::/0"), nil
	}
	var out []netip.Prefix
	for _, s := range splitList(value) {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return nil, fmt.Errorf("GATEWAY_ALLOW_CIDRS: %w", err)
		}
		out = append(out, p.Masked())
	}
	return out, nil
}

func parsePorts(value string) (map[int]bool, error) {
	out := map[int]bool{}
	for _, s := range splitList(value) {
		p, err := strconv.Atoi(s)
		if err != nil || p <= 0 || p > 65535 {
			return nil, fmt.Errorf("GATEWAY_ALLOW_PORTS: invalid port %q", s)
		}
		out[p] = true
	}
	return out, nil
}

func describeAllow(allow []netip.Prefix) string {
	parts := make([]string, len(allow))
	for i, p := range allow {
		parts[i] = p.String()
	}
	return strings.Join(parts, ",")
}

type gateway struct {
	dialer  dialer
	allow   []netip.Prefix
	ports   map[int]bool
	tailcat *tailcatDialer
}

func (g *gateway) allowed(ip netip.Addr) bool {
	ip = ip.Unmap()
	for _, p := range g.allow {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// dial connects to host:port, refusing addresses outside the allow list so the gateway cannot be
// used to reach arbitrary hosts.
func (g *gateway) dial(ctx context.Context, target string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || !g.ports[port] {
		return nil, fmt.Errorf("port %s is not allowed", portStr)
	}
	candidates := []string{host}
	if _, err := netip.ParseAddr(host); err != nil {
		resolved, err := g.dialer.LookupHost(ctx, host)
		if err != nil {
			return nil, err
		}
		if resolved != nil {
			candidates = resolved
		}
	}
	var lastErr error = fmt.Errorf("%s is not in the allowed networks", host)
	for _, c := range candidates {
		if ip, err := netip.ParseAddr(c); err == nil && !g.allowed(ip) {
			continue
		}
		conn, err := g.dialer.DialContext(ctx, "tcp", net.JoinHostPort(c, portStr))
		if err != nil {
			lastErr = err
			continue
		}
		remote, err := netip.ParseAddrPort(conn.RemoteAddr().String())
		if err != nil || !g.allowed(remote.Addr()) {
			conn.Close()
			lastErr = fmt.Errorf("%s resolved outside the allowed networks", host)
			continue
		}
		return conn, nil
	}
	return nil, lastErr
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	viaTailcat := strings.HasPrefix(path, tailcatPath)
	target, err := url.PathUnescape(strings.TrimPrefix(strings.TrimPrefix(path, directPath), tailcatPath))
	if err != nil || viaTailcat && g.tailcat == nil {
		http.Error(w, "bad target", http.StatusBadRequest)
		return
	}
	var tcp net.Conn
	if viaTailcat {
		// The tunnel's first use reaches a DERP relay and waits for the host to answer.
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		tcp, err = g.tailcat.Dial(ctx, target)
		cancel()
		target = target[:12] + "..."
	} else {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		tcp, err = g.dial(ctx, target)
		cancel()
	}
	if err != nil {
		log.Printf("direct %s: %v", target, err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		tcp.Close()
		log.Printf("direct %s: %v", target, err)
		return
	}
	log.Printf("direct %s: connected for %s", target, r.RemoteAddr)
	start := time.Now()
	up, down := bridge(ws, tcp)
	log.Printf("direct %s: closed after %s, %d bytes up, %d bytes down",
		target, time.Since(start).Round(time.Second), up, down)
}
