package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Incoming struct {
	Type            string            `json:"type"`
	ProtocolVersion int               `json:"protocolVersion"`
	ClientID        string            `json:"clientId"`
	Name            string            `json:"name"`
	Hostname        string            `json:"hostname"`
	OS              string            `json:"os"`
	Arch            string            `json:"arch"`
	Version         string            `json:"version"`
	Tags            []string          `json:"tags"`
	EnrollmentToken string            `json:"enrollmentToken"`
	AgentToken      string            `json:"agentToken"`
	HeartbeatSec    int               `json:"heartbeatIntervalSec"`
	Jobs            []map[string]any  `json:"jobs"`
	Message         string            `json:"message"`
	JobID           string            `json:"jobId"`
	Command         string            `json:"command"`
	Shell           string            `json:"shell"`
	Cwd             string            `json:"cwd"`
	Env             map[string]string `json:"env"`
	TimeoutMs       int64             `json:"timeoutMs"`
	MaxOutputBytes  int64             `json:"maxOutputBytes"`
	Offset          int64             `json:"offset"`
	EndOffset       int64             `json:"endOffset"`
	Seq             int64             `json:"seq"`
	Stream          string            `json:"stream"`
	Data            string            `json:"data"`
	ExitCode        *int              `json:"exitCode"`
	Cancelled       bool              `json:"cancelled"`
	RequestID       string            `json:"requestId"`
	Method          string            `json:"method"`
	Params          json.RawMessage   `json:"params"`
	TransferID      string            `json:"transferId"`
	Path            string            `json:"path"`
	Size            int64             `json:"size"`
	SHA256          string            `json:"sha256"`
	Overwrite       bool              `json:"overwrite"`
	CreateDirs      bool              `json:"createDirs"`
	Received        int64             `json:"received"`
}

type Agent struct {
	cfg *Config
	log *Logger

	mu        sync.Mutex
	conn      *websocket.Conn
	connected bool

	sendMu sync.Mutex

	heartbeatStop chan struct{}
	heartbeatOnce sync.Once

	jobs      map[string]*Job
	jobsMu    sync.Mutex
	uploads   map[string]*UploadTransfer
	uploadsMu sync.Mutex
	downloads map[string]*DownloadTransfer
	downMu    sync.Mutex
}

func NewAgent(cfg *Config, logger *Logger) *Agent {
	return &Agent{
		cfg:       cfg,
		log:       logger,
		jobs:      make(map[string]*Job),
		uploads:   make(map[string]*UploadTransfer),
		downloads: make(map[string]*DownloadTransfer),
	}
}

func (a *Agent) Run(ctx context.Context) {
	go func() {
		<-ctx.Done()
		a.closeConn()
	}()
	backoff := time.Second
	for ctx.Err() == nil {
		err := a.connectAndServe(ctx)
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			a.log.Warnf("连接断开: %v", err)
		}
		delay := backoff + time.Duration(rand.Int63n(int64(backoff/2+1)))
		if delay > 60*time.Second {
			delay = 60 * time.Second
		}
		a.log.Infof("%s 后重连", delay.Round(time.Millisecond))
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			break
		}
		if backoff < 60*time.Second {
			backoff *= 2
			if backoff > 60*time.Second {
				backoff = 60 * time.Second
			}
		}
	}
	a.log.Infof("agent 退出，停止所有任务")
	a.killAllJobs()
}

func (a *Agent) connectAndServe(ctx context.Context) error {
	dialer := websocket.Dialer{
		HandshakeTimeout: 20 * time.Second,
		Proxy:            a.proxyFunc(),
		TLSClientConfig:  a.tlsConfig(),
	}
	header := http.Header{}
	if a.cfg.AgentToken != "" {
		header.Set("Authorization", "Bearer "+a.cfg.AgentToken)
	}
	conn, _, err := dialer.DialContext(ctx, a.cfg.Server, header)
	if err != nil {
		return err
	}
	conn.SetReadLimit(64 * 1024 * 1024)

	a.mu.Lock()
	a.conn = conn
	a.connected = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.connected = false
		if a.conn == conn {
			a.conn = nil
		}
		a.mu.Unlock()
		_ = conn.Close()
		a.stopHeartbeat()
	}()

	a.log.Infof("已连接 %s", a.cfg.Server)
	if err := a.sendHello(); err != nil {
		return err
	}

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var msg Incoming
		if err := json.Unmarshal(raw, &msg); err != nil {
			a.log.Warnf("收到非法消息: %v", err)
			continue
		}
		a.handleMessage(msg)
	}
}

func (a *Agent) proxyFunc() func(*http.Request) (*url.URL, error) {
	if a.cfg.Proxy == "" {
		return http.ProxyFromEnvironment
	}
	proxyURL, err := url.Parse(a.cfg.Proxy)
	if err != nil {
		a.log.Warnf("proxy 配置无效: %v", err)
		return http.ProxyFromEnvironment
	}
	return http.ProxyURL(proxyURL)
}

func (a *Agent) tlsConfig() *tls.Config {
	cfg := &tls.Config{
		InsecureSkipVerify: a.cfg.InsecureSkipVerify,
		MinVersion:         tls.VersionTLS12,
	}
	if a.cfg.CAFile != "" {
		pem, err := os.ReadFile(a.cfg.CAFile)
		if err != nil {
			a.log.Warnf("读取 CA 失败: %v", err)
		} else {
			pool := x509.NewCertPool()
			pool.AppendCertsFromPEM(pem)
			cfg.RootCAs = pool
		}
	}
	return cfg
}

func (a *Agent) sendHello() error {
	hostname, _ := os.Hostname()
	info := basicHostInfo()
	return a.send(map[string]any{
		"type":            "hello",
		"protocolVersion": 1,
		"clientId":        a.cfg.ClientID,
		"name":            a.cfg.Name,
		"hostname":        hostname,
		"os":              info.OS,
		"arch":            runtime.GOARCH,
		"version":         Version,
		"tags":            a.cfg.Tags,
		"enrollmentToken": a.cfg.EnrollmentToken,
		"agentToken":      a.cfg.AgentToken,
		"jobs":            a.jobStates(),
	})
}

func (a *Agent) handleMessage(msg Incoming) {
	switch msg.Type {
	case "hello_ack":
		if msg.AgentToken != "" && msg.AgentToken != a.cfg.AgentToken {
			a.cfg.AgentToken = msg.AgentToken
			if err := a.cfg.SaveState(); err != nil {
				a.log.Warnf("保存 agent token 失败: %v", err)
			}
		}
		if msg.HeartbeatSec > 0 {
			a.cfg.HeartbeatIntervalSec = msg.HeartbeatSec
		}
		a.log.Infof("注册成功 clientId=%s", a.cfg.ClientID)
		a.startHeartbeat()
		_ = a.send(map[string]any{"type": "agent.info", "info": collectInfo(nil)})
	case "hello_error":
		a.log.Errorf("注册失败: %s", msg.Message)
	case "heartbeat_ack":
		// no-op
	case "rpc":
		go a.handleRPC(msg)
	case "exec.start":
		go a.startExec(msg)
	case "exec.cancel":
		a.cancelJob(msg.JobID)
	case "exec.resume":
		a.resumeJob(msg.JobID, msg.Offset)
	case "exec.chunk.ack":
		// 由 TCP 背压控制即可
	case "file.upload.start":
		go a.startUpload(msg)
	case "file.upload.chunk":
		a.uploadChunk(msg)
	case "file.download.start":
		go a.startDownload(msg)
	case "file.download.ack":
		a.downloadAck(msg.TransferID)
	case "file.download.cancel":
		a.cancelDownload(msg.TransferID)
	default:
		a.log.Debugf("未知消息: %s", msg.Type)
	}
}

func (a *Agent) send(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	a.mu.Lock()
	conn := a.conn
	connected := a.connected
	a.mu.Unlock()
	if !connected || conn == nil {
		return errors.New("not connected")
	}
	_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return conn.WriteMessage(websocket.TextMessage, data)
}

func (a *Agent) startHeartbeat() {
	a.heartbeatOnce.Do(func() {
		a.heartbeatStop = make(chan struct{})
		go func() {
			interval := time.Duration(a.cfg.HeartbeatIntervalSec) * time.Second
			if interval <= 0 {
				interval = 15 * time.Second
			}
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					if err := a.send(map[string]any{"type": "heartbeat", "ts": time.Now().UnixMilli()}); err != nil {
						a.closeConn()
						return
					}
				case <-a.heartbeatStop:
					return
				}
			}
		}()
	})
}

func (a *Agent) stopHeartbeat() {
	if a.heartbeatStop != nil {
		select {
		case <-a.heartbeatStop:
		default:
			close(a.heartbeatStop)
		}
	}
	a.heartbeatOnce = sync.Once{}
}

func (a *Agent) closeConn() {
	a.mu.Lock()
	conn := a.conn
	a.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (a *Agent) handleRPC(msg Incoming) {
	result, err := a.dispatchRPC(msg.Method, msg.Params)
	resp := map[string]any{
		"type":      "rpc_result",
		"requestId": msg.RequestID,
		"ok":        err == nil,
	}
	if err != nil {
		resp["error"] = err.Error()
	} else {
		resp["result"] = result
	}
	_ = a.send(resp)
}

func (a *Agent) dispatchRPC(method string, raw json.RawMessage) (any, error) {
	switch method {
	case "client.info":
		var params struct {
			Include []string `json:"include"`
		}
		_ = json.Unmarshal(raw, &params)
		return collectInfo(params.Include), nil

	case "client.stats":
		return collectStats(), nil

	case "file.read":
		var params FileReadParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, err
		}
		return fileRead(a.cfg, params)

	case "file.tail":
		var params FileTailParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, err
		}
		return fileTail(a.cfg, params)

	case "file.search":
		var params FileSearchParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, err
		}
		return fileSearch(a.cfg, params)

	case "file.list":
		var params FileListParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, err
		}
		return fileList(a.cfg, params)

	case "file.stat":
		var params FileStatParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, err
		}
		return fileStat(a.cfg, params)

	case "file.write":
		var params FileWriteParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, err
		}
		return fileWrite(a.cfg, params)

	case "file.delete":
		var params FileDeleteParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, err
		}
		return fileDelete(a.cfg, params)

	default:
		return nil, fmt.Errorf("unknown rpc method: %s", method)
	}
}

func (a *Agent) jobStates() []map[string]any {
	a.jobsMu.Lock()
	defer a.jobsMu.Unlock()
	out := make([]map[string]any, 0, len(a.jobs))
	for _, job := range a.jobs {
		job.mu.Lock()
		status := "running"
		if job.done {
			status = "exited"
		}
		out = append(out, map[string]any{
			"jobId":       job.ID,
			"status":      status,
			"exitCode":    job.exitCode,
			"agentOffset": job.offset,
			"endedAt":     job.endedAt,
		})
		job.mu.Unlock()
	}
	return out
}

func (a *Agent) killAllJobs() {
	a.jobsMu.Lock()
	jobs := make([]*Job, 0, len(a.jobs))
	for _, job := range a.jobs {
		jobs = append(jobs, job)
	}
	a.jobsMu.Unlock()
	for _, job := range jobs {
		job.cancel()
	}
}

func (a *Agent) getJob(id string) *Job {
	a.jobsMu.Lock()
	defer a.jobsMu.Unlock()
	return a.jobs[id]
}

func (a *Agent) putJob(job *Job) {
	a.jobsMu.Lock()
	defer a.jobsMu.Unlock()
	a.jobs[job.ID] = job
}

func (a *Agent) deleteJob(id string) {
	a.jobsMu.Lock()
	defer a.jobsMu.Unlock()
	delete(a.jobs, id)
}

func (a *Agent) sendChunk(jobID string, offset, endOffset, seq int64, stream string, data []byte, truncated bool) {
	_ = a.send(map[string]any{
		"type":      "exec.chunk",
		"jobId":     jobID,
		"offset":    offset,
		"endOffset": endOffset,
		"seq":       seq,
		"stream":    stream,
		"data":      base64.StdEncoding.EncodeToString(data),
		"truncated": truncated,
		"sentAt":    time.Now().UnixMilli(),
	})
}
