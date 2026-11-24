package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type wgPeer struct {
	publicKey    string
	presharedKey string
	endpoint     string
	allowedIPs   []netip.Prefix
	keepalive    int
}

type wgConfig struct {
	privateKey string
	addresses  []netip.Addr
	dns        []netip.Addr
	listenPort int
	mtu        int
	peers      []wgPeer
	// resolved holds the endpoint each peer (by public key) was configured with.
	resolved map[string]string
}

// parseWgQuick reads the subset of a wg-quick config a userspace tunnel needs; keys that only
// matter to wg-quick's host routing (Table, PostUp, ...) are ignored.
func parseWgQuick(path string) (*wgConfig, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	cfg := &wgConfig{mtu: 1420}
	var section string
	var peer *wgPeer
	scanner := bufio.NewScanner(f)
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(strings.SplitN(scanner.Text(), "#", 2)[0])
		if text == "" {
			continue
		}
		if strings.HasPrefix(text, "[") {
			section = strings.ToLower(strings.Trim(text, "[]"))
			if section == "peer" {
				cfg.peers = append(cfg.peers, wgPeer{})
				peer = &cfg.peers[len(cfg.peers)-1]
			}
			continue
		}
		key, value, ok := strings.Cut(text, "=")
		if !ok {
			return nil, fmt.Errorf("%s:%d: expected key = value", path, line)
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if err := cfg.set(section, peer, key, value); err != nil {
			return nil, fmt.Errorf("%s:%d: %s: %w", path, line, key, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if cfg.privateKey == "" || len(cfg.addresses) == 0 || len(cfg.peers) == 0 {
		return nil, fmt.Errorf("%s: needs PrivateKey, Address and at least one [Peer]", path)
	}
	return cfg, nil
}

func (cfg *wgConfig) set(section string, peer *wgPeer, key, value string) error {
	var err error
	switch section + "." + key {
	case "interface.privatekey":
		cfg.privateKey, err = keyToHex(value)
	case "interface.address":
		for _, s := range splitList(value) {
			p, perr := netip.ParsePrefix(s)
			if perr != nil {
				a, aerr := netip.ParseAddr(s)
				if aerr != nil {
					return perr
				}
				p = netip.PrefixFrom(a, a.BitLen())
			}
			cfg.addresses = append(cfg.addresses, p.Addr())
		}
	case "interface.dns":
		for _, s := range splitList(value) {
			if a, aerr := netip.ParseAddr(s); aerr == nil {
				cfg.dns = append(cfg.dns, a)
			}
		}
	case "interface.listenport":
		cfg.listenPort, err = strconv.Atoi(value)
	case "interface.mtu":
		cfg.mtu, err = strconv.Atoi(value)
	case "peer.publickey":
		peer.publicKey, err = keyToHex(value)
	case "peer.presharedkey":
		peer.presharedKey, err = keyToHex(value)
	case "peer.endpoint":
		peer.endpoint = value
	case "peer.allowedips":
		for _, s := range splitList(value) {
			p, perr := netip.ParsePrefix(s)
			if perr != nil {
				return perr
			}
			peer.allowedIPs = append(peer.allowedIPs, p)
		}
	case "peer.persistentkeepalive":
		if value != "off" {
			peer.keepalive, err = strconv.Atoi(value)
		}
	}
	return err
}

func splitList(value string) []string {
	var out []string
	for _, s := range strings.Split(value, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func keyToHex(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) != 32 {
		return "", fmt.Errorf("invalid WireGuard key")
	}
	return hex.EncodeToString(raw), nil
}

// resolveEndpoint resolves a host:port endpoint, as WireGuard itself only takes IPs.
func resolveEndpoint(endpoint string) (string, error) {
	host, port, err := net.SplitHostPort(endpoint)
	if err != nil {
		return "", err
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return endpoint, nil
	}
	ips, err := net.DefaultResolver.LookupNetIP(context.Background(), "ip", host)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("resolve %s: %v", host, err)
	}
	ip := ips[0]
	for _, candidate := range ips {
		if candidate.Is4() {
			ip = candidate
			break
		}
	}
	return net.JoinHostPort(ip.Unmap().String(), port), nil
}

func (cfg *wgConfig) uapi() (string, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\n", cfg.privateKey)
	if cfg.listenPort > 0 {
		fmt.Fprintf(&b, "listen_port=%d\n", cfg.listenPort)
	}
	for _, p := range cfg.peers {
		fmt.Fprintf(&b, "public_key=%s\n", p.publicKey)
		if p.presharedKey != "" {
			fmt.Fprintf(&b, "preshared_key=%s\n", p.presharedKey)
		}
		if p.endpoint != "" {
			ep, err := resolveEndpoint(p.endpoint)
			if err != nil {
				return "", err
			}
			fmt.Fprintf(&b, "endpoint=%s\n", ep)
			if cfg.resolved == nil {
				cfg.resolved = map[string]string{}
			}
			cfg.resolved[p.publicKey] = ep
		}
		if p.keepalive > 0 {
			fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", p.keepalive)
		}
		for _, a := range p.allowedIPs {
			fmt.Fprintf(&b, "allowed_ip=%s\n", a)
		}
	}
	return b.String(), nil
}

type wgDialer struct {
	net    *netstack.Net
	dev    *device.Device
	cfg    *wgConfig
	routes []netip.Prefix
}

// newWgDialer brings up a userspace WireGuard interface inside this process, so the container
// needs neither NET_ADMIN nor /dev/net/tun.
func newWgDialer(path string, verbose bool) (*wgDialer, error) {
	cfg, err := parseWgQuick(path)
	if err != nil {
		return nil, err
	}
	tunDev, tnet, err := netstack.CreateNetTUN(cfg.addresses, cfg.dns, cfg.mtu)
	if err != nil {
		return nil, err
	}
	level := device.LogLevelError
	if verbose {
		level = device.LogLevelVerbose
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(level, "wireguard: "))
	conf, err := cfg.uapi()
	if err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.IpcSet(conf); err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	d := &wgDialer{net: tnet, dev: dev, cfg: cfg}
	for _, p := range cfg.peers {
		d.routes = append(d.routes, p.allowedIPs...)
	}
	go d.refreshEndpoints()
	log.Printf("WireGuard up: address %v, peers %d", cfg.addresses, len(cfg.peers))
	return d, nil
}

// refreshEndpoints re-resolves hostname endpoints, so a peer behind dynamic DNS is followed when
// its address changes. Peers that roam on their own are left alone between changes.
func (d *wgDialer) refreshEndpoints() {
	last := d.cfg.resolved
	for {
		time.Sleep(2 * time.Minute)
		for _, p := range d.cfg.peers {
			if p.endpoint == "" {
				continue
			}
			host, _, err := net.SplitHostPort(p.endpoint)
			if err != nil {
				continue
			}
			if _, err := netip.ParseAddr(host); err == nil {
				continue
			}
			ep, err := resolveEndpoint(p.endpoint)
			if err != nil {
				log.Printf("WireGuard endpoint %s: %v", p.endpoint, err)
				continue
			}
			if last[p.publicKey] != ep {
				log.Printf("WireGuard endpoint %s moved to %s", p.endpoint, ep)
				if err := d.dev.IpcSet(fmt.Sprintf("public_key=%s\nendpoint=%s\n", p.publicKey, ep)); err != nil {
					log.Printf("WireGuard endpoint update: %v", err)
				}
			}
			last[p.publicKey] = ep
		}
	}
}

func (d *wgDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return d.net.DialContext(ctx, network, address)
}

func (d *wgDialer) LookupHost(ctx context.Context, host string) ([]string, error) {
	if len(d.cfg.dns) > 0 {
		return d.net.LookupContextHost(ctx, host)
	}
	return net.DefaultResolver.LookupHost(ctx, host)
}

func (d *wgDialer) DefaultAllowed() []netip.Prefix {
	return d.routes
}

func (d *wgDialer) Name() string { return "wireguard" }
