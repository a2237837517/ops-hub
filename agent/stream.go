package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"time"
)

const (
	streamOpen     = 1
	streamOpenOK   = 2
	streamOpenFail = 3
	streamData     = 4
	streamClose    = 5
)

type streamOpenRequest struct {
	ClientID  string `json:"clientId,omitempty"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	LocalPort int    `json:"localPort,omitempty"`
}

type agentStream struct {
	id   uint32
	conn net.Conn
}

// handleStreamFrame 处理 Hub 通过 Agent 反向连接发来的二进制隧道帧：
// [1 字节类型][4 字节 streamId][payload]
func (a *Agent) handleStreamFrame(raw []byte) {
	if len(raw) < 5 {
		return
	}
	typ := raw[0]
	id := binary.BigEndian.Uint32(raw[1:5])
	payload := raw[5:]
	switch typ {
	case streamOpen:
		go a.openStream(id, payload)
	case streamData:
		a.streamWrite(id, payload)
	case streamClose:
		a.closeStream(id)
	}
}

func (a *Agent) openStream(id uint32, payload []byte) {
	var req streamOpenRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		_ = a.sendStream(streamOpenFail, id, []byte("invalid open request"))
		return
	}
	if err := validateTunnelTarget(req.Host, req.Port, a.cfg.AllowPublicTargets); err != nil {
		_ = a.sendStream(streamOpenFail, id, []byte(err.Error()))
		return
	}
	addr := net.JoinHostPort(req.Host, strconv.Itoa(req.Port))
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		_ = a.sendStream(streamOpenFail, id, []byte(err.Error()))
		return
	}
	stream := &agentStream{id: id, conn: conn}
	a.streamsMu.Lock()
	if old := a.streams[id]; old != nil {
		_ = old.conn.Close()
	}
	a.streams[id] = stream
	a.streamsMu.Unlock()
	if err := a.sendStream(streamOpenOK, id, nil); err != nil {
		a.closeStream(id)
		return
	}
	a.log.Infof("隧道流已打开 stream=%d target=%s", id, addr)
	go a.pumpStream(stream)
}

func (a *Agent) pumpStream(stream *agentStream) {
	buf := make([]byte, 32*1024)
	for {
		n, err := stream.conn.Read(buf)
		if n > 0 {
			if sendErr := a.sendStream(streamData, stream.id, buf[:n]); sendErr != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	a.closeStream(stream.id)
	_ = a.sendStream(streamClose, stream.id, nil)
}

func (a *Agent) streamWrite(id uint32, payload []byte) {
	a.streamsMu.Lock()
	stream := a.streams[id]
	a.streamsMu.Unlock()
	if stream == nil {
		return
	}
	_ = stream.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if _, err := stream.conn.Write(payload); err != nil {
		a.closeStream(id)
		_ = a.sendStream(streamClose, id, nil)
	}
}

func (a *Agent) closeStream(id uint32) {
	a.streamsMu.Lock()
	stream := a.streams[id]
	delete(a.streams, id)
	a.streamsMu.Unlock()
	if stream != nil {
		_ = stream.conn.Close()
	}
}

func (a *Agent) closeAllStreams() {
	a.streamsMu.Lock()
	streams := a.streams
	a.streams = make(map[uint32]*agentStream)
	a.streamsMu.Unlock()
	for _, stream := range streams {
		_ = stream.conn.Close()
	}
}

func (a *Agent) sendStream(typ byte, id uint32, payload []byte) error {
	frame := make([]byte, 5+len(payload))
	frame[0] = typ
	binary.BigEndian.PutUint32(frame[1:5], id)
	copy(frame[5:], payload)
	return a.sendBinary(frame)
}

func validateTunnelTarget(host string, port int, allowPublic bool) error {
	if host == "" {
		return fmt.Errorf("目标地址为空")
	}
	if port <= 0 || port > 65535 {
		return fmt.Errorf("目标端口无效: %d", port)
	}
	if allowPublic {
		return nil
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("解析目标 %s 失败: %w", host, err)
	}
	for _, ip := range ips {
		if !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast() {
			return fmt.Errorf("目标 %s 不是内网地址", ip)
		}
	}
	return nil
}
