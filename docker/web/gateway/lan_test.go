package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"
)

// fakeSealDeskHost is the host side of sealdesk src/lan.rs accept(), echoing one message.
func fakeSealDeskHost(t *testing.T, conn net.Conn, key ed25519.PrivateKey) {
	defer conn.Close()
	hs := newPlainStream(conn)
	if pre, err := hs.readFrame(); err != nil || string(pre) != lanDomain {
		t.Errorf("preface %q, %v", pre, err)
		return
	}
	private := make([]byte, 32)
	rand.Read(private)
	ephemeral, _ := curve25519.X25519(private, curve25519.Basepoint)
	h := lanHello{Key: byteArray(key.Public().(ed25519.PublicKey)), Ephemeral: ephemeral, Nonce: make([]byte, 32)}
	rand.Read(h.Nonce)
	h.Signature = ed25519.Sign(key, h.body(0, nil))
	prior, _ := json.Marshal(&h)
	hs.writeFrame(prior)
	b, err := hs.readFrame()
	if err != nil {
		return // the client refused this host
	}
	var c lanHello
	if json.Unmarshal(b, &c) != nil || !c.valid(1, prior) {
		t.Errorf("client hello %s rejected: %v", b, err)
		return
	}
	shared, _ := curve25519.X25519(private, c.Ephemeral)
	v := binary.LittleEndian.AppendUint32(nil, 1)
	host := &lanStream{plain: hs}
	host.send, _ = keyedHash(shared, []byte(kxSplit), []byte{2}, v, v, c.Ephemeral, ephemeral)
	host.recv, _ = keyedHash(shared, []byte(kxSplit), []byte{1}, v, v, c.Ephemeral, ephemeral)
	host.writeFrame([]byte(lanDomain))
	if confirm, err := host.readFrame(); err != nil || string(confirm) != lanDomain {
		t.Errorf("confirmation %q, %v", confirm, err)
		return
	}
	msg, err := host.readFrame()
	if err == nil {
		host.writeFrame(append([]byte("echo:"), msg...))
	}
}

func TestSealDeskLAN(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, hostKey, _ := ed25519.GenerateKey(rand.Reader)
	stock := make(chan bool, 1)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			if <-stock {
				// A stock RustDesk host's first frame is its Hash message.
				newPlainStream(conn).writeFrame([]byte("\x4a\x02\x0a\x00"))
				conn.Close()
				continue
			}
			go fakeSealDeskHost(t, conn, hostKey)
		}
	}()
	c := &lanClient{path: filepath.Join(t.TempDir(), "lan.json"), Hosts: map[string]string{},
		id: ed25519.NewKeyFromSeed(make([]byte, 32))}
	connect := func(isStock bool) (*lanStream, error) {
		stock <- isStock
		conn, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		return c.handshake(conn, "host", time.Now().Add(5*time.Second))
	}

	s, err := connect(false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.writeFrame([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	if got, err := s.readFrame(); err != nil || string(got) != "echo:ping" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := connect(true); !errors.Is(err, errNotSealDesk) {
		t.Fatalf("stock host: %v", err)
	}
	_, hostKey, _ = ed25519.GenerateKey(rand.Reader)
	if _, err := connect(false); err == nil {
		t.Fatal("a changed host key was accepted")
	}
}
