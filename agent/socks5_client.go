package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

type socks5Spec struct {
	Addr string
	User string
	Pass string
}

func (c *tunnelClient) acceptSocks5(listener net.Listener, spec socks5Spec) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go c.handleSocks5(conn, spec)
	}
}

func socks5Reply(conn net.Conn, code byte) {
	_, _ = conn.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
}

func (c *tunnelClient) handleSocks5(conn net.Conn, spec socks5Spec) {
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))

	var greeting [2]byte
	if _, err := io.ReadFull(conn, greeting[:]); err != nil {
		_ = conn.Close()
		return
	}
	if greeting[0] != 5 {
		_ = conn.Close()
		return
	}
	methods := make([]byte, greeting[1])
	if _, err := io.ReadFull(conn, methods); err != nil {
		_ = conn.Close()
		return
	}

	needAuth := spec.User != ""
	method := byte(0)
	if needAuth {
		method = 2
	}
	supported := false
	for _, item := range methods {
		if item == method {
			supported = true
			break
		}
	}
	if !supported {
		_, _ = conn.Write([]byte{5, 0xff})
		_ = conn.Close()
		return
	}
	_, _ = conn.Write([]byte{5, method})

	if needAuth {
		var authHead [2]byte
		if _, err := io.ReadFull(conn, authHead[:]); err != nil {
			_ = conn.Close()
			return
		}
		if authHead[0] != 1 {
			_ = conn.Close()
			return
		}
		username := make([]byte, authHead[1])
		if _, err := io.ReadFull(conn, username); err != nil {
			_ = conn.Close()
			return
		}
		var passLen [1]byte
		if _, err := io.ReadFull(conn, passLen[:]); err != nil {
			_ = conn.Close()
			return
		}
		password := make([]byte, passLen[0])
		if _, err := io.ReadFull(conn, password); err != nil {
			_ = conn.Close()
			return
		}
		if string(username) != spec.User || string(password) != spec.Pass {
			_, _ = conn.Write([]byte{1, 1})
			_ = conn.Close()
			return
		}
		_, _ = conn.Write([]byte{1, 0})
	}

	var request [4]byte
	if _, err := io.ReadFull(conn, request[:]); err != nil {
		_ = conn.Close()
		return
	}
	if request[0] != 5 || request[1] != 1 {
		socks5Reply(conn, 7)
		_ = conn.Close()
		return
	}

	var host string
	switch request[3] {
	case 1:
		addr := make([]byte, 4)
		if _, err := io.ReadFull(conn, addr); err != nil {
			_ = conn.Close()
			return
		}
		host = net.IP(addr).String()
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			_ = conn.Close()
			return
		}
		name := make([]byte, length[0])
		if _, err := io.ReadFull(conn, name); err != nil {
			_ = conn.Close()
			return
		}
		host = string(name)
	case 4:
		addr := make([]byte, 16)
		if _, err := io.ReadFull(conn, addr); err != nil {
			_ = conn.Close()
			return
		}
		host = net.IP(addr).String()
	default:
		socks5Reply(conn, 8)
		_ = conn.Close()
		return
	}

	var portBuf [2]byte
	if _, err := io.ReadFull(conn, portBuf[:]); err != nil {
		_ = conn.Close()
		return
	}
	port := int(portBuf[0])<<8 | int(portBuf[1])

	_ = conn.SetDeadline(time.Time{})
	stream, err := c.openStream(conn, host, port, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[tunnel] SOCKS5 %s:%d 失败: %v\n", host, port, err)
		socks5Reply(conn, 5)
		_ = conn.Close()
		return
	}
	_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	go stream.writeLoop()

	buf := make([]byte, 32*1024)
	for {
		n, readErr := conn.Read(buf)
		if n > 0 {
			if sendErr := c.sendFrame(streamData, stream.id, buf[:n]); sendErr != nil {
				break
			}
		}
		if readErr != nil {
			break
		}
	}
	c.removeStream(stream.id)
	_ = c.sendFrame(streamClose, stream.id, nil)
}
