package main

import (
	"context"
	"net"
	"net/netip"
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
