package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"strings"

	"tailscale.com/tsnet"
)

type dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
	// LookupHost returns nil when names are resolved by the dial itself.
	LookupHost(ctx context.Context, host string) ([]string, error)
	DefaultAllowed() []netip.Prefix
	Name() string
}

func mustPrefixes(list ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(list))
	for _, s := range list {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}

type systemDialer struct{ net.Dialer }

func (d *systemDialer) LookupHost(ctx context.Context, host string) ([]string, error) {
	return net.DefaultResolver.LookupHost(ctx, host)
}

// Private ranges only: LAN hosts, and the addresses VPNs running on the Docker host hand out.
func (d *systemDialer) DefaultAllowed() []netip.Prefix {
	return mustPrefixes("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
		"169.254.0.0/16", "fc00::/7", "fe80::/10")
}

func (d *systemDialer) Name() string { return "system" }

type tailscaleDialer struct{ srv *tsnet.Server }

// newTailscaleDialer joins a Tailscale or Headscale tailnet in-process. Tailscale adds NAT
// traversal on top of WireGuard, so neither side needs a forwarded port.
func newTailscaleDialer(verbose bool) (*tailscaleDialer, error) {
	dir := envOr("TS_STATE_DIR", "/var/lib/rustdesk-web/tailscale")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	srv := &tsnet.Server{
		Dir:        dir,
		Hostname:   envOr("TS_HOSTNAME", "rustdesk-web"),
		AuthKey:    os.Getenv("TS_AUTHKEY"),
		ControlURL: os.Getenv("TS_LOGIN_SERVER"),
		Ephemeral:  strings.EqualFold(os.Getenv("TS_EPHEMERAL"), "true"),
		UserLogf:   log.Printf,
	}
	if verbose {
		srv.Logf = log.Printf
	} else {
		srv.Logf = func(string, ...any) {}
	}
	status, err := srv.Up(context.Background())
	if err != nil {
		return nil, fmt.Errorf("tailscale: %w", err)
	}
	log.Printf("Tailscale up: %v", status.TailscaleIPs)
	return &tailscaleDialer{srv: srv}, nil
}

func (d *tailscaleDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return d.srv.Dial(ctx, network, address)
}

func (d *tailscaleDialer) LookupHost(context.Context, string) ([]string, error) {
	return nil, nil
}

func (d *tailscaleDialer) DefaultAllowed() []netip.Prefix {
	return mustPrefixes("100.64.0.0/10", "fd7a:115c:a1e0::/48")
}

func (d *tailscaleDialer) Name() string { return "tailscale" }
