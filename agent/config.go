package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const Version = "0.1.20"

type Config struct {
	Server               string   `json:"server"`
	EnrollmentToken      string   `json:"enrollmentToken"`
	AgentToken           string   `json:"agentToken"`
	ClientID             string   `json:"clientId"`
	Name                 string   `json:"name"`
	Tags                 []string `json:"tags"`
	SpoolDir             string   `json:"spoolDir"`
	AllowedRoots         []string `json:"allowedRoots"`
	MaxSpoolMB           int64    `json:"maxSpoolMB"`
	MaxConcurrentJobs    int      `json:"maxConcurrentJobs"`
	MaxTransferKBps      int      `json:"maxTransferKBps"`
	InsecureSkipVerify   bool     `json:"insecureSkipVerify"`
	CAFile               string   `json:"caFile"`
	Proxy                string   `json:"proxy"`
	HeartbeatIntervalSec int      `json:"heartbeatIntervalSec"`
	AllowPublicTargets   bool     `json:"allowPublicTargets"`
	DisableRemoteUpgrade bool     `json:"disableRemoteUpgrade"`

	// StateReset 表示 agent-state.json 来自另一台机器，本次启动已丢弃旧身份。
	StateReset bool `json:"-"`
}

type AgentState struct {
	ClientID           string `json:"clientId"`
	AgentToken         string `json:"agentToken"`
	MachineKey         string `json:"machineKey,omitempty"`
	MachineFingerprint string `json:"machineFingerprint,omitempty"`
}

func DefaultConfig() *Config {
	return &Config{
		Server:               "ws://127.0.0.1:7100/agent",
		SpoolDir:             defaultSpoolDir(),
		MaxSpoolMB:           2048,
		MaxConcurrentJobs:    4,
		Tags:                 []string{},
		AllowedRoots:         []string{},
		HeartbeatIntervalSec: 15,
	}
}

func LoadConfig(path string) (*Config, error) {
	cfg := DefaultConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置 %s 失败: %w", path, err)
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("解析配置 %s 失败: %w", path, err)
	}
	if cfg.SpoolDir == "" {
		cfg.SpoolDir = defaultSpoolDir()
	}
	if cfg.MaxSpoolMB <= 0 {
		cfg.MaxSpoolMB = 2048
	}
	if cfg.MaxConcurrentJobs <= 0 {
		cfg.MaxConcurrentJobs = 4
	}
	if cfg.HeartbeatIntervalSec <= 0 {
		cfg.HeartbeatIntervalSec = 15
	}
	if cfg.Name == "" {
		cfg.Name, _ = os.Hostname()
	}
	if cfg.Server == "" {
		cfg.Server = DefaultConfig().Server
	}

	statePath := filepath.Join(cfg.SpoolDir, "agent-state.json")
	state := AgentState{}
	if raw, err := os.ReadFile(statePath); err == nil {
		_ = json.Unmarshal(raw, &state)
	}
	// 磁盘/目录被整机复制或克隆时，agent-state.json 会带着原机器的 clientId 和 agentToken。
	// 指纹不一致说明这份状态不是本机的，直接丢弃重新注册，避免两台机器互相顶掉。
	if state.ClientID != "" && state.MachineKey != "" && state.MachineKey != machineKey() {
		cfg.StateReset = true
		state = AgentState{}
	}
	if cfg.ClientID == "" {
		cfg.ClientID = state.ClientID
	}
	if cfg.AgentToken == "" {
		cfg.AgentToken = state.AgentToken
	}
	if cfg.ClientID == "" {
		cfg.ClientID = buildClientID()
	}
	if cfg.AgentToken == "" && state.AgentToken != "" {
		cfg.AgentToken = state.AgentToken
	}

	cfg.AllowedRoots = normalizeRoots(cfg.AllowedRoots)
	if err := os.MkdirAll(cfg.SpoolDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建 spool 目录失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(cfg.SpoolDir, "jobs"), 0o755); err != nil {
		return nil, fmt.Errorf("创建 jobs 目录失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(cfg.SpoolDir, "logs"), 0o755); err != nil {
		return nil, fmt.Errorf("创建 logs 目录失败: %w", err)
	}
	cfg.cleanupSpool()
	return cfg, nil
}

func (c *Config) cleanupSpool() {
	if c.MaxSpoolMB <= 0 {
		return
	}
	entries, err := filepath.Glob(filepath.Join(c.SpoolDir, "jobs", "*"))
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	items := make([]item, 0, len(entries))
	var total int64
	for _, path := range entries {
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		items = append(items, item{path: path, size: info.Size(), mod: info.ModTime()})
		total += info.Size()
	}
	limit := c.MaxSpoolMB * 1024 * 1024
	if total <= limit {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	for _, it := range items {
		if total <= limit*8/10 {
			break
		}
		if err := os.Remove(it.path); err == nil {
			total -= it.size
		}
	}
}

func (c *Config) SaveState() error {
	state := AgentState{
		ClientID:           c.ClientID,
		AgentToken:         c.AgentToken,
		MachineKey:         machineKey(),
		MachineFingerprint: machineFingerprint(),
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(c.SpoolDir, "agent-state.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(path)
		return os.Rename(tmp, path)
	}
	return nil
}

func buildClientID() string {
	hostname, _ := os.Hostname()
	machine := machineID()
	sum := sha256.Sum256([]byte(machine + "|" + hostname))
	suffix := hex.EncodeToString(sum[:])[:10]
	name := sanitizeID(hostname)
	if name == "" {
		name = "agent"
	}
	return name + "-" + suffix
}

func sanitizeID(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 80 {
		out = out[:80]
	}
	return out
}

func normalizeRoots(roots []string) []string {
	out := make([]string, 0, len(roots))
	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		abs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		out = append(out, filepath.Clean(abs))
	}
	return out
}

func (c *Config) IsPathAllowed(path string) bool {
	if len(c.AllowedRoots) == 0 {
		return true
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	abs = filepath.Clean(abs)
	for _, root := range c.AllowedRoots {
		if pathWithin(root, abs) {
			return true
		}
	}
	return false
}

func pathWithin(root, target string) bool {
	if runtime.GOOS == "windows" {
		root = strings.ToLower(root)
		target = strings.ToLower(target)
	}
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)))
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func platformOS() string {
	return runtime.GOOS
}
