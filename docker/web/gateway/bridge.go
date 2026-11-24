package main

import (
	"bufio"
	"net"
	"sync"

	"github.com/gorilla/websocket"
)

// The default origin check stays: only the page this gateway serves may open a tunnel.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  64 << 10,
	WriteBufferSize: 64 << 10,
}

// bridge carries one protobuf message per WebSocket message on the browser side and
// BytesCodec frames on the host side, the conversion hbbr makes between web and native peers.
func bridge(ws *websocket.Conn, tcp net.Conn) (up, down int64) {
	ws.SetReadLimit(maxFrameLength)
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			tcp.Close()
			ws.Close()
		})
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer closeBoth()
		r := bufio.NewReaderSize(tcp, 64<<10)
		for {
			payload, err := readFrame(r)
			if err != nil {
				ws.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
			if err := ws.WriteMessage(websocket.BinaryMessage, payload); err != nil {
				return
			}
			down += int64(len(payload))
		}
	}()
	func() {
		defer closeBoth()
		for {
			kind, payload, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if kind != websocket.BinaryMessage {
				continue
			}
			frame, err := encodeFrame(payload)
			if err != nil {
				return
			}
			if _, err := tcp.Write(frame); err != nil {
				return
			}
			up += int64(len(payload))
		}
	}()
	wg.Wait()
	return up, down
}
