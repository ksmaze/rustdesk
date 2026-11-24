package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"

	"golang.org/x/crypto/curve25519"
)

func genKeyPair() (priv, pub string, err error) {
	var k [32]byte
	if _, err := rand.Read(k[:]); err != nil {
		return "", "", err
	}
	k[0] &= 248
	k[31] = (k[31] & 127) | 64
	p, err := curve25519.X25519(k[:], curve25519.Basepoint)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(k[:]), base64.StdEncoding.EncodeToString(p), nil
}

// wgPair writes a matching pair of configs: windows.conf for WireGuard for Windows on the RustDesk
// host, which listens, and wg0.conf for this container, which dials out and keeps the NAT open.
func wgPair(args []string) error {
	fs := flag.NewFlagSet("wg-pair", flag.ContinueOnError)
	endpoint := fs.String("endpoint", "", "address the container reaches the Windows host on: LAN IP, public IP or DDNS name")
	port := fs.Int("port", 51820, "UDP port WireGuard listens on, on the Windows host")
	subnet := fs.String("subnet", "10.66.0.0/24", "tunnel subnet; the host takes .1, the container .2")
	out := fs.String("out", "/out", "directory to write windows.conf and wg0.conf to")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *endpoint == "" {
		return errors.New("wg-pair: -endpoint is required")
	}
	prefix, err := netip.ParsePrefix(*subnet)
	if err != nil || !prefix.Addr().Is4() || prefix.Bits() > 30 {
		return fmt.Errorf("wg-pair: -subnet must be an IPv4 /30 or larger: %v", err)
	}
	hostIP := prefix.Masked().Addr().Next()
	webIP := hostIP.Next()
	hostPriv, hostPub, err := genKeyPair()
	if err != nil {
		return err
	}
	webPriv, webPub, err := genKeyPair()
	if err != nil {
		return err
	}
	windows := fmt.Sprintf(`# WireGuard for Windows, on the RustDesk host. Import as a tunnel and activate it.
[Interface]
PrivateKey = %s
Address = %s/%d
ListenPort = %d

[Peer]
# rustdesk-web container
PublicKey = %s
AllowedIPs = %s/32
`, hostPriv, hostIP, prefix.Bits(), *port, webPub, webIP)
	container := fmt.Sprintf(`# rustdesk-web container: mount as /etc/wireguard/wg0.conf.
[Interface]
PrivateKey = %s
Address = %s/32

[Peer]
# Windows RustDesk host; connect to %s in the web client.
PublicKey = %s
Endpoint = %s
AllowedIPs = %s/32
PersistentKeepalive = 25
`, webPriv, webIP, hostIP, hostPub, net.JoinHostPort(*endpoint, fmt.Sprint(*port)), hostIP)
	if err := os.MkdirAll(*out, 0o700); err != nil {
		return err
	}
	for name, body := range map[string]string{"windows.conf": windows, "wg0.conf": container} {
		if err := os.WriteFile(filepath.Join(*out, name), []byte(body), 0o600); err != nil {
			return err
		}
	}
	fmt.Printf("Wrote %s and %s. In the web client, connect to %s.\n",
		filepath.Join(*out, "windows.conf"), filepath.Join(*out, "wg0.conf"), hostIP)
	return nil
}
