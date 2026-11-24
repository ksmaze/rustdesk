package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/secretbox"
)

// SealDesk's encrypted LAN transport (sealdesk src/lan.rs): a SealDesk host refuses plain
// RustDesk clients on its direct port unless its compatibility mode is on, so the gateway sends
// the protocol preface, exchanges signed hellos and runs the session under per-direction
// secretbox keys. A stock RustDesk host answers the preface with its Hash frame instead, and is
// then dialed again without it.
const (
	lanDomain     = "sealdesk-lan-v1"
	lanBindDomain = "sealdesk-login-bind-v1"
	lanFrameLimit = 4096
	lanFirstWait  = 3 * time.Second
	kxSplit       = "rdkx-spl"
)

var errNotSealDesk = errors.New("not a SealDesk LAN host")

// byteArray is serde's encoding of Vec<u8>: an array of numbers, not base64.
type byteArray []byte

func (b byteArray) MarshalJSON() ([]byte, error) {
	ints := make([]int, len(b))
	for i, v := range b {
		ints[i] = int(v)
	}
	return json.Marshal(ints)
}

func (b *byteArray) UnmarshalJSON(data []byte) error {
	var ints []int
	if err := json.Unmarshal(data, &ints); err != nil {
		return err
	}
	out := make([]byte, len(ints))
	for i, v := range ints {
		if v < 0 || v > 255 {
			return fmt.Errorf("byte value %d out of range", v)
		}
		out[i] = byte(v)
	}
	*b = out
	return nil
}

type lanHello struct {
	Key       byteArray `json:"key"`
	Ephemeral byteArray `json:"ephemeral"`
	Nonce     byteArray `json:"nonce"`
	Signature byteArray `json:"signature"`
}

func (h *lanHello) body(role byte, prior []byte) []byte {
	b := append([]byte(lanDomain), role)
	b = append(b, prior...)
	b = append(b, h.Key...)
	b = append(b, h.Ephemeral...)
	return append(b, h.Nonce...)
}

func (h *lanHello) valid(role byte, prior []byte) bool {
	return len(h.Key) == ed25519.PublicKeySize && len(h.Ephemeral) == 32 && len(h.Nonce) == 32 &&
		len(h.Signature) == ed25519.SignatureSize &&
		ed25519.Verify(ed25519.PublicKey(h.Key), h.body(role, prior), h.Signature)
}

// looksLikeJSON mirrors SealDesk's split between a JSON value that is not a valid hello, which
// fails the connection, and a frame that is not this protocol at all, which falls back.
func looksLikeJSON(frame []byte) bool {
	t := bytes.TrimLeft(frame, " \t\r\n")
	return len(t) > 0 && bytes.IndexByte([]byte(`{["tfn-0123456789`), t[0]) >= 0
}

func keyedHash(key []byte, parts ...[]byte) ([32]byte, error) {
	var out [32]byte
	h, err := blake2b.New(32, key)
	if err != nil {
		return out, err
	}
	for _, p := range parts {
		h.Write(p)
	}
	copy(out[:], h.Sum(nil))
	return out, nil
}

// hostStream is one RustDesk session stream to a host, a frame at a time.
type hostStream interface {
	readFrame() ([]byte, error)
	writeFrame(payload []byte) error
}

type plainStream struct {
	r *bufio.Reader
	w io.Writer
}

func newPlainStream(conn net.Conn) *plainStream {
	return &plainStream{bufio.NewReaderSize(conn, 64<<10), conn}
}

func (s *plainStream) readFrame() ([]byte, error) { return readFrame(s.r, maxFrameLength) }

func (s *plainStream) writeFrame(payload []byte) error {
	frame, err := encodeFrame(payload)
	if err != nil {
		return err
	}
	_, err = s.w.Write(frame)
	return err
}

// lanStream is hbb_common's split-key Encrypt: secretbox with the frame counter, starting at
// one, as the little-endian nonce prefix. Frames of one byte or less pass in the clear.
type lanStream struct {
	plain          *plainStream
	send, recv     [32]byte
	sent, received uint64
	binder         [32]byte
	hostKey        []byte
}

func lanNonce(n uint64) *[24]byte {
	var nonce [24]byte
	binary.LittleEndian.PutUint64(nonce[:8], n)
	return &nonce
}

func (s *lanStream) readFrame() ([]byte, error) {
	b, err := s.plain.readFrame()
	if err != nil || len(b) <= 1 {
		return b, err
	}
	s.received++
	out, ok := secretbox.Open(nil, b, lanNonce(s.received), &s.recv)
	if !ok {
		return nil, errors.New("SealDesk LAN decryption failed")
	}
	return out, nil
}

func (s *lanStream) writeFrame(payload []byte) error {
	s.sent++
	return s.plain.writeFrame(secretbox.Seal(nil, payload, lanNonce(s.sent), &s.send))
}

// lanClient is the gateway's SealDesk LAN identity, and the host keys it has seen per address.
type lanClient struct {
	path string
	id   ed25519.PrivateKey
	mu   sync.Mutex
	// Hosts maps "ip:port" to the hex host key first seen there.
	Hosts map[string]string `json:"hosts"`
	Seed  string            `json:"seed"`
}

func newLanClient() (*lanClient, error) {
	path := filepath.Join(envOr("GATEWAY_STATE_DIR", "/var/lib/rustdesk-web"), "sealdesk-lan.json")
	c := &lanClient{path: path, Hosts: map[string]string{}}
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(data, c); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	case !os.IsNotExist(err):
		return nil, err
	}
	seed, err := hex.DecodeString(c.Seed)
	if err != nil || len(seed) != ed25519.SeedSize {
		seed = make([]byte, ed25519.SeedSize)
		if _, err := rand.Read(seed); err != nil {
			return nil, err
		}
		c.Seed = hex.EncodeToString(seed)
		if c.Hosts == nil {
			c.Hosts = map[string]string{}
		}
		if err := c.save(); err != nil {
			return nil, err
		}
	}
	c.id = ed25519.NewKeyFromSeed(seed)
	return c, nil
}

func (c *lanClient) pinned(target string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Hosts[target] != ""
}

func (c *lanClient) save() error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(c.path, data, 0o600)
}

// handshake runs the client side of SealDesk's LAN handshake on conn, returning errNotSealDesk
// when the host does not speak it.
func (c *lanClient) handshake(conn net.Conn, target string, deadline time.Time) (*lanStream, error) {
	plain := newPlainStream(conn)
	if err := plain.writeFrame([]byte(lanDomain)); err != nil {
		return nil, err
	}
	first := time.Now().Add(lanFirstWait)
	if first.After(deadline) {
		first = deadline
	}
	conn.SetDeadline(first)
	prior, err := readFrame(plain.r, lanFrameLimit)
	var ne net.Error
	if errors.Is(err, io.EOF) || errors.As(err, &ne) && ne.Timeout() {
		return nil, errNotSealDesk
	} else if err != nil {
		return nil, err
	}
	conn.SetDeadline(deadline)
	var host lanHello
	if err := json.Unmarshal(prior, &host); err != nil {
		if !looksLikeJSON(prior) {
			return nil, errNotSealDesk
		}
		return nil, fmt.Errorf("invalid SealDesk LAN hello: %w", err)
	}
	if !host.valid(0, nil) {
		return nil, errors.New("SealDesk LAN signature verification failed")
	}
	hostKey := hex.EncodeToString(host.Key)
	c.mu.Lock()
	known := c.Hosts[target]
	c.mu.Unlock()
	if known != "" && known != hostKey {
		return nil, fmt.Errorf("SealDesk host identity at %s changed; remove it from %s to trust the new one",
			target, c.path)
	}

	private := make([]byte, 32)
	nonce := make([]byte, 32)
	if _, err := rand.Read(private); err != nil {
		return nil, err
	}
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	ephemeral, err := curve25519.X25519(private, curve25519.Basepoint)
	if err != nil {
		return nil, err
	}
	our := lanHello{Key: byteArray(c.id.Public().(ed25519.PublicKey)), Ephemeral: ephemeral, Nonce: nonce}
	our.Signature = ed25519.Sign(c.id, our.body(1, prior))
	hello, err := json.Marshal(&our)
	if err != nil {
		return nil, err
	}
	if err := plain.writeFrame(hello); err != nil {
		return nil, err
	}
	shared, err := curve25519.X25519(private, host.Ephemeral)
	if err != nil {
		return nil, err
	}
	s := &lanStream{plain: plain, hostKey: host.Key}
	if s.binder, err = keyedHash(shared, []byte(lanBindDomain), host.Key, our.Key,
		host.Ephemeral, our.Ephemeral, host.Nonce, our.Nonce); err != nil {
		return nil, err
	}
	// KxTranscript version 1, the gateway as initiator: advertised and picked are both 1.
	version := binary.LittleEndian.AppendUint32(nil, 1)
	subkey := func(direction byte) ([32]byte, error) {
		return keyedHash(shared, []byte(kxSplit), []byte{direction}, version, version, our.Ephemeral, host.Ephemeral)
	}
	if s.send, err = subkey(1); err != nil {
		return nil, err
	}
	if s.recv, err = subkey(2); err != nil {
		return nil, err
	}
	confirm, err := s.readFrame()
	if err != nil {
		return nil, fmt.Errorf("SealDesk LAN key confirmation: %w", err)
	}
	if string(confirm) != lanDomain {
		return nil, errors.New("SealDesk LAN key confirmation failed")
	}
	if err := s.writeFrame([]byte(lanDomain)); err != nil {
		return nil, err
	}
	conn.SetDeadline(time.Time{})
	if known == "" {
		c.mu.Lock()
		known = c.Hosts[target]
		if known == "" {
			c.Hosts[target] = hostKey
			err = c.save()
		}
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		if known != "" && known != hostKey {
			return nil, fmt.Errorf("SealDesk host identity at %s changed; remove it from %s to trust the new one",
				target, c.path)
		}
		if known == "" {
			log.Printf("SealDesk LAN host %s trusted with key %s", target, hostKey)
		}
	}
	return s, nil
}
