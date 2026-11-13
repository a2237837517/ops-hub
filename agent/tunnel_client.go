package main

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

type tunnelForward struct {
	Local int
	Host  string
	Port  int
}

type tunnelResult struct {
	ok  bool
	msg string
}

type localStream struct {
	conn net.Conn
	ch   chan []byte
	done chan struct{}
	once sync.Once
}

func (s *localStream) close() {
	s.once.Do(func() {
		close(s.done)
		_ = s.conn.Close()
	})
}

type tunnelClient struct {
	server   string
	token    string
	clientID string
	bind     string
	insecure bool
	forwards []tunnelForward

	mu        sync.Mutex
	conn      *websocket.Conn
	writeMu   sync.Mutex
	listeners []net.Listener
	pending   map[uint32]chan tunnelResult
	streams   map[uint32]*localStream
	nextID    uint32
	closed    chan struct{}
}

type multiFlag []string

func (m *multiFlag) String() string { return strings.Join(*m, ",") }

func (m *multiFlag) Set(value string) error {
	*m = append(*m, value)
	return nil
}

func runTunnelClient(args []string) {
	fs := flag.NewFlagSet("tunnel", flag.ExitOnError)
	server := fs.String("server", "", "隧道服务地址，例如 wss://mcp.example.com/agent/tunnel")
	token := fs.String("token", "", "隧道令牌")
	clientID := fs.String("client", "", "目标客户端 ID")
	bind := fs.String("bind", "127.0.0.1", "本地监听地址")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验（仅测试）")
	var forwards multiFlag
	fs.Var(&forwards, "forward", "端口转发，格式 本地端口=目标主机:目标端口，可重复")
	_ = fs.Parse(args)

	if *server == "" || *token == "" || *clientID == "" || len(forwards) == 0 {
		fmt.Fprintln(os.Stderr, "用法: ops-agent tunnel --server wss://.../agent/tunnel --token <token> --client <clientId> --forward 13306=127.0.0.1:3306")
		os.Exit(2)
	}

	parsed := make([]tunnelForward, 0, len(forwards))
	for _, spec := range forwards {
		forward, err := parseForward(spec)
		if err != nil {
			fmt.Fprintf(os.Stderr, "参数错误: %v\n", err)
			os.Exit(2)
		}
		parsed = append(parsed, forward)
	}

	client := &tunnelClient{
		server:   *server,
		token:    *token,
		clientID: *clientID,
		bind:     *bind,
		insecure: *insecure,
		forwards: parsed,
		pending:  make(map[uint32]chan tunnelResult),
		streams:  make(map[uint32]*localStream),
		closed:   make(chan struct{}),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := client.connectAndServe(ctx)
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "[tunnel] 断开: %v\n", err)
		}
		if time.Since(started) > 60*time.Second {
			backoff = time.Second
		}
		delay := backoff
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
		fmt.Fprintf(os.Stderr, "[tunnel] %s 后重连\n", delay)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
	client.closeAll()
	fmt.Fprintln(os.Stderr, "[tunnel] 已退出")
}

func parseForward(spec string) (tunnelForward, error) {
	parts := strings.SplitN(spec, "=", 2)
	if len(parts) != 2 {
		return tunnelForward{}, fmt.Errorf("%q 不是 本地端口=主机:端口 格式", spec)
	}
	local, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || local <= 0 || local > 65535 {
		return tunnelForward{}, fmt.Errorf("本地端口无效: %q", parts[0])
	}
	host, portText, err := net.SplitHostPort(strings.TrimSpace(parts[1]))
	if err != nil {
		return tunnelForward{}, fmt.Errorf("目标地址无效: %q", parts[1])
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 || port > 65535 {
		return tunnelForward{}, fmt.Errorf("目标端口无效: %q", portText)
	}
	if host == "" {
		host = "127.0.0.1"
	}
	return tunnelForward{Local: local, Host: host, Port: port}, nil
}

func (c *tunnelClient) connectAndServe(ctx context.Context) error {
	dialer := websocket.Dialer{
		HandshakeTimeout: 20 * time.Second,
		Proxy:            nil,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: c.insecure,
			MinVersion:         tls.VersionTLS12,
		},
	}
	u, err := url.Parse(c.server)
	if err != nil {
		return err
	}
	query := u.Query()
	query.Set("clientId", c.clientID)
	u.RawQuery = query.Encode()

	header := http.Header{}
	header.Set("Authorization", "Bearer "+c.token)
	conn, _, err := dialer.DialContext(ctx, u.String(), header)
	if err != nil {
		return err
	}
	conn.SetReadLimit(32 * 1024 * 1024)

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	// Ctrl+C / SIGTERM 时主动关闭 WebSocket，否则 ReadMessage 会一直阻塞，进程退不掉。
	connDone := make(chan struct{})
	defer close(connDone)
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-connDone:
		}
	}()

	defer func() {
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.mu.Unlock()
		_ = conn.Close()
	}()

	if err := c.startListeners(); err != nil {
		return err
	}
	defer c.stopListeners()
	fmt.Fprintln(os.Stderr, "[tunnel] 已连接，按 Ctrl+C 退出")

	go c.pingLoop(ctx, conn)
	return c.readLoop(conn)
}

func (c *tunnelClient) startListeners() error {
	opened := 0
	for _, forward := range c.forwards {
		address := net.JoinHostPort(c.bind, strconv.Itoa(forward.Local))
		listener, err := net.Listen("tcp", address)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[tunnel] 监听 %s 失败: %v\n", address, err)
			continue
		}
		c.listeners = append(c.listeners, listener)
		opened++
		fmt.Fprintf(os.Stderr, "[tunnel] 本地 %s -> %s:%d\n", address, forward.Host, forward.Port)
		go c.acceptLoop(listener, forward)
	}
	if opened == 0 {
		return errors.New("没有可用的本地监听端口")
	}
	return nil
}

func (c *tunnelClient) stopListeners() {
	for _, listener := range c.listeners {
		_ = listener.Close()
	}
	c.listeners = nil
}

func (c *tunnelClient) acceptLoop(listener net.Listener, forward tunnelForward) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go c.handleLocal(conn, forward)
	}
}

func (c *tunnelClient) handleLocal(conn net.Conn, forward tunnelForward) {
	id := atomic.AddUint32(&c.nextID, 1)
	if id == 0 {
		id = atomic.AddUint32(&c.nextID, 1)
	}
	resultCh := make(chan tunnelResult, 1)
	c.mu.Lock()
	c.pending[id] = resultCh
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	// 先注册 stream 再发 OPEN：MySQL/SSH 这类服务在 TCP 建连后立刻发 greeting，
	// 如果等 OPEN_OK 再注册，第一批 DATA 会被丢掉，表现为 handshake 超时。
	stream := &localStream{
		conn: conn,
		ch:   make(chan []byte, 64),
		done: make(chan struct{}),
	}
	c.mu.Lock()
	c.streams[id] = stream
	c.mu.Unlock()
	go stream.writeLoop()

	payload, _ := json.Marshal(streamOpenRequest{
		Host:      forward.Host,
		Port:      forward.Port,
		LocalPort: forward.Local,
	})
	if err := c.sendFrame(streamOpen, id, payload); err != nil {
		c.removeStream(id)
		return
	}

	select {
	case result := <-resultCh:
		if !result.ok {
			fmt.Fprintf(os.Stderr, "[tunnel] %s:%d 打开失败: %s\n", forward.Host, forward.Port, result.msg)
			c.removeStream(id)
			return
		}
	case <-time.After(15 * time.Second):
		fmt.Fprintf(os.Stderr, "[tunnel] %s:%d 打开超时\n", forward.Host, forward.Port)
		c.removeStream(id)
		return
	case <-c.closed:
		c.removeStream(id)
		return
	}

	buf := make([]byte, 32*1024)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			if sendErr := c.sendFrame(streamData, id, buf[:n]); sendErr != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	c.removeStream(id)
	_ = c.sendFrame(streamClose, id, nil)
}

func (s *localStream) writeLoop() {
	for {
		select {
		case data := <-s.ch:
			if _, err := s.conn.Write(data); err != nil {
				return
			}
		case <-s.done:
			return
		}
	}
}

func (c *tunnelClient) readLoop(conn *websocket.Conn) error {
	for {
		messageType, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if messageType != websocket.BinaryMessage || len(raw) < 5 {
			continue
		}
		typ := raw[0]
		id := binary.BigEndian.Uint32(raw[1:5])
		payload := raw[5:]
		switch typ {
		case streamOpenOK:
			c.resolvePending(id, tunnelResult{ok: true})
		case streamOpenFail:
			c.resolvePending(id, tunnelResult{ok: false, msg: string(payload)})
		case streamData:
			c.mu.Lock()
			stream := c.streams[id]
			c.mu.Unlock()
			if stream != nil {
				select {
				case stream.ch <- payload:
				default:
					c.removeStream(id)
				}
			}
		case streamClose:
			c.removeStream(id)
		}
	}
}

func (c *tunnelClient) resolvePending(id uint32, result tunnelResult) {
	c.mu.Lock()
	ch := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if ch != nil {
		select {
		case ch <- result:
		default:
		}
	}
}

func (c *tunnelClient) removeStream(id uint32) {
	c.mu.Lock()
	stream := c.streams[id]
	delete(c.streams, id)
	c.mu.Unlock()
	if stream != nil {
		stream.close()
	}
}

func (c *tunnelClient) sendFrame(typ byte, id uint32, payload []byte) error {
	frame := make([]byte, 5+len(payload))
	frame[0] = typ
	binary.BigEndian.PutUint32(frame[1:5], id)
	copy(frame[5:], payload)

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return errors.New("not connected")
	}
	_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return conn.WriteMessage(websocket.BinaryMessage, frame)
}

func (c *tunnelClient) pingLoop(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			c.writeMu.Lock()
			_ = conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(10*time.Second))
			c.writeMu.Unlock()
		case <-ctx.Done():
			return
		}
	}
}

func (c *tunnelClient) closeAll() {
	c.stopListeners()
	c.mu.Lock()
	streams := c.streams
	c.streams = make(map[uint32]*localStream)
	c.mu.Unlock()
	for _, stream := range streams {
		stream.close()
	}
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
}
