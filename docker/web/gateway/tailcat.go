package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// SealDesk hosts serve their RustDesk session port over tailcat at this port.
const sealdeskPort = 21118

// tailcatDialer reaches SealDesk hosts by their "tc..." address: WireGuard with NAT traversal,
// falling back to a DERP relay that only sees ciphertext. One tunnel per host address is kept
// while any session uses it.
type tailcatDialer struct {
	key     key.NodePrivate
	derpMap string
	mu      sync.Mutex
	clients map[string]*tailcatClient
}

type tailcatClient struct {
	*tailcat.Client
	refs int
}

// Same JSON shape as SealDesk's controller key file, so the key can be moved between them.
type tailcatKeyFile struct {
	Private key.NodePrivate
	Public  key.NodePublic
}

func loadTailcatKey(path string) (key.NodePrivate, error) {
	var f tailcatKeyFile
	b, err := os.ReadFile(path)
	if err == nil {
		err = json.Unmarshal(b, &f)
		return f.Private, err
	}
	if !errors.Is(err, os.ErrNotExist) {
		return key.NodePrivate{}, err
	}
	f.Private = key.NewNode()
	f.Public = f.Private.Public()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return key.NodePrivate{}, err
	}
	b, err = json.Marshal(f)
	if err != nil {
		return key.NodePrivate{}, err
	}
	return f.Private, os.WriteFile(path, b, 0o600)
}

func newTailcatDialer() (*tailcatDialer, error) {
	path := filepath.Join(envOr("GATEWAY_STATE_DIR", "/var/lib/rustdesk-web"), "tailcat-client.json")
	k, err := loadTailcatKey(path)
	if err != nil {
		return nil, err
	}
	pub, _ := k.Public().MarshalText()
	log.Printf("SealDesk controller identity: %s (for a host's allow list)", pub)
	return &tailcatDialer{
		key:     k,
		derpMap: os.Getenv("TAILCAT_DERP_MAP_URL"),
		clients: map[string]*tailcatClient{},
	}, nil
}

// isTailcatAddr matches SealDesk's is_addr: "tc" followed by unpadded base64url.
func isTailcatAddr(s string) bool {
	if len(s) <= 40 || !strings.HasPrefix(s, "tc") {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (d *tailcatDialer) acquire(addr string) *tailcatClient {
	d.mu.Lock()
	defer d.mu.Unlock()
	c := d.clients[addr]
	if c == nil {
		cl := tailcat.NewClient(tailcat.Addr(addr))
		cl.Key = d.key
		cl.DERPMapURL = d.derpMap
		cl.Logf = logger.Discard
		c = &tailcatClient{Client: cl}
		d.clients[addr] = c
	}
	c.refs++
	return c
}

func (d *tailcatDialer) release(addr string, c *tailcatClient) {
	d.mu.Lock()
	defer d.mu.Unlock()
	c.refs--
	if c.refs > 0 {
		return
	}
	if d.clients[addr] == c {
		delete(d.clients, addr)
	}
	go c.Close()
}

// Dial returns a stream to the host's RustDesk session, released with the returned conn.
func (d *tailcatDialer) Dial(ctx context.Context, addr string) (net.Conn, error) {
	if !isTailcatAddr(addr) {
		return nil, errors.New("not a tailcat address")
	}
	c := d.acquire(addr)
	conn, err := c.DialTCPPort(ctx, sealdeskPort)
	if err != nil {
		d.release(addr, c)
		return nil, err
	}
	return &releasingConn{Conn: conn, release: func() { d.release(addr, c) }}, nil
}

type releasingConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *releasingConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.release)
	return err
}
