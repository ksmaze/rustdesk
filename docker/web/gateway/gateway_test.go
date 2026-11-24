package main

import (
	"bufio"
	"bytes"
	"fmt"
	"net"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

func TestFrameRoundTrip(t *testing.T) {
	var stream bytes.Buffer
	sizes := []int{0, 1, 0x3F, 0x40, 0x3FFF, 0x4000, 0x3FFFFF, 0x400000}
	for _, n := range sizes {
		frame, err := encodeFrame(bytes.Repeat([]byte{byte(n)}, n))
		if err != nil {
			t.Fatal(err)
		}
		stream.Write(frame)
	}
	r := bufio.NewReader(&stream)
	for _, n := range sizes {
		got, err := readFrame(r, maxFrameLength)
		if err != nil {
			t.Fatalf("size %d: %v", n, err)
		}
		if !bytes.Equal(got, bytes.Repeat([]byte{byte(n)}, n)) {
			t.Fatalf("size %d: payload mismatch", n)
		}
	}
}

// A RustDesk host reached through a real WireGuard tunnel: the "host" is a second userspace
// WireGuard peer whose TCP 21118 echoes BytesCodec frames back.
func TestDirectOverWireGuard(t *testing.T) {
	hostPriv, hostPub, _ := genKeyPair()
	webPriv, webPub, _ := genKeyPair()
	hostTun, hostNet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.66.0.1")}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	hostDev := device.NewDevice(hostTun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, ""))
	defer hostDev.Close()
	hk, _ := keyToHex(hostPriv)
	wk, _ := keyToHex(webPub)
	if err := hostDev.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=0\npublic_key=%s\nallowed_ip=10.66.0.2/32\n", hk, wk)); err != nil {
		t.Fatal(err)
	}
	hostDev.Up()
	listenPort := devicePort(t, hostDev)
	ln, err := hostNet.ListenTCP(&net.TCPAddr{Port: 21118})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	// The gateway first tries SealDesk's LAN handshake, then reconnects to a stock host.
	echo := func(c net.Conn) {
		defer c.Close()
		r := bufio.NewReader(c)
		for {
			payload, err := readFrame(r, maxFrameLength)
			if err != nil {
				return
			}
			frame, _ := encodeFrame(append([]byte("echo:"), payload...))
			c.Write(frame)
		}
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go echo(c)
		}
	}()

	conf := filepath.Join(t.TempDir(), "wg0.conf")
	os.WriteFile(conf, []byte(fmt.Sprintf(`[Interface]
PrivateKey = %s
Address = 10.66.0.2/32
[Peer]
PublicKey = %s
Endpoint = 127.0.0.1:%d
AllowedIPs = 10.66.0.1/32
PersistentKeepalive = 25
`, webPriv, hostPub, listenPort)), 0o600)
	d, err := newWgDialer(conf, false)
	if err != nil {
		t.Fatal(err)
	}
	defer d.dev.Close()
	g := &gateway{dialer: d, allow: d.DefaultAllowed(), ports: map[int]bool{21118: true}}
	srv := httptest.NewServer(g)
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + directPath

	ws, _, err := websocket.DefaultDialer.Dial(wsURL+"10.66.0.1:21118", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	big := bytes.Repeat([]byte("x"), 200000)
	for _, msg := range [][]byte{[]byte("hi"), big} {
		if err := ws.WriteMessage(websocket.BinaryMessage, msg); err != nil {
			t.Fatal(err)
		}
		_, got, err := ws.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, append([]byte("echo:"), msg...)) {
			t.Fatalf("got %d bytes back, want %d", len(got), len(msg)+5)
		}
	}

	for _, target := range []string{"10.66.0.1:22", "10.66.0.3:21118", "8.8.8.8:21118"} {
		ws, _, err := websocket.DefaultDialer.Dial(wsURL+target, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, _, err = ws.ReadMessage()
		ws.Close()
		if !websocket.IsCloseError(err, 4502) {
			t.Fatalf("%s: expected refusal, got %v", target, err)
		}
	}
}

func devicePort(t *testing.T, dev *device.Device) int {
	conf, err := dev.IpcGet()
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(conf, "\n") {
		var p int
		if _, err := fmt.Sscanf(line, "listen_port=%d", &p); err == nil {
			return p
		}
	}
	t.Fatal("no listen port")
	return 0
}
