package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
)

// hbb_common's BytesCodec: the low 2 bits of the first byte give the header length minus one,
// the rest of the little-endian header is the payload length.
const maxFrameLength = 0x3FFF_FFFF

func encodeFrame(payload []byte) ([]byte, error) {
	n := len(payload)
	var head []byte
	switch {
	case n <= 0x3F:
		head = []byte{byte(n << 2)}
	case n <= 0x3FFF:
		head = binary.LittleEndian.AppendUint16(nil, uint16(n<<2)|0x1)
	case n <= 0x3FFFFF:
		h := uint32(n<<2) | 0x2
		head = []byte{byte(h), byte(h >> 8), byte(h >> 16)}
	case n <= maxFrameLength:
		head = binary.LittleEndian.AppendUint32(nil, uint32(n<<2)|0x3)
	default:
		return nil, fmt.Errorf("frame of %d bytes exceeds the codec limit", n)
	}
	return append(head, payload...), nil
}

func readFrame(r *bufio.Reader, limit int) ([]byte, error) {
	first, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	headLen := int(first&0x3) + 1
	n := int(first)
	for i := 1; i < headLen; i++ {
		b, err := r.ReadByte()
		if err != nil {
			return nil, err
		}
		n |= int(b) << (8 * i)
	}
	n >>= 2
	if n > limit {
		return nil, fmt.Errorf("frame of %d bytes exceeds %d", n, limit)
	}
	// Grow with the bytes that arrive rather than trusting the declared length up front.
	var payload bytes.Buffer
	if got, err := payload.ReadFrom(io.LimitReader(r, int64(n))); err != nil {
		return nil, err
	} else if got != int64(n) {
		return nil, io.ErrUnexpectedEOF
	}
	return payload.Bytes(), nil
}
