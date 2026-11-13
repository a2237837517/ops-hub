package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		return
	}
	command := os.Args[1]
	if command == "tunnel" {
		runTunnelClient(os.Args[2:])
		return
	}
	fs := flag.NewFlagSet(command, flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "配置文件路径")
	_ = fs.Parse(os.Args[2:])

	switch command {
	case "run":
		if isServiceMode() {
			if err := runService(*configPath); err != nil {
				fmt.Fprintf(os.Stderr, "service error: %v\n", err)
				os.Exit(1)
			}
			return
		}
		runForeground(*configPath)

	case "install":
		if err := installService(*configPath); err != nil {
			fmt.Fprintf(os.Stderr, "install error: %v\n", err)
			os.Exit(1)
		}

	case "uninstall":
		if err := uninstallService(); err != nil {
			fmt.Fprintf(os.Stderr, "uninstall error: %v\n", err)
			os.Exit(1)
		}

	case "reset-id":
		resetIdentity(*configPath)

	case "version", "--version", "-v":
		fmt.Printf("ops-hub-agent %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)

	case "help", "--help", "-h":
		printUsage()

	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", command)
		printUsage()
		os.Exit(1)
	}
}

func runForeground(configPath string) {
	cfg, err := LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config error: %v\n", err)
		os.Exit(1)
	}
	logger := NewLogger(cfg)
	defer logger.Close()
	if cfg.StateReset {
		logger.Warnf("agent-state.json 来自另一台机器，已丢弃旧身份并重新生成 clientId=%s", cfg.ClientID)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Infof("ops-hub-agent %s starting, clientId=%s server=%s", Version, cfg.ClientID, cfg.Server)
	agent := NewAgent(cfg, logger)
	agent.Run(ctx)
}

func defaultConfigPath() string {
	if env := os.Getenv("OPS_HUB_AGENT_CONFIG"); env != "" {
		return env
	}
	exe, err := os.Executable()
	if err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "config.json")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		candidate := filepath.Join(cwd, "config.json")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	if err == nil {
		return filepath.Join(filepath.Dir(exe), "config.json")
	}
	return "config.json"
}

func printUsage() {
	fmt.Print(`ops-hub-agent - Ops Hub 远程运维客户端

用法:
  ops-agent run [--config config.json]       前台运行
  ops-agent install [--config config.json]   Windows: 安装并启动服务；Linux 用 install-linux.sh
  ops-agent uninstall                        Windows: 停止并卸载服务
  ops-agent reset-id                         清除本机客户端身份（会重新注册，clientId 重新生成）
  ops-agent tunnel --server ... --token ... --client ... --forward 13306=127.0.0.1:3306
                                             本地端口转发到目标机器（可重复 --forward）
  ops-agent version
  ops-agent help

说明:
  - 客户端只主动连接 wss://.../agent，不需要公网 IP，不需要开入站端口。
  - Windows Server 2008 R2 请使用 Go 1.20 构建的 amd64/386 版本。
  - 配置文件默认在 exe 同目录的 config.json。
  - 复制/克隆整机后如需保留为独立客户端，先停止服务再执行 reset-id。
`)
}

// resetIdentity 生成一个全新的 clientId，并清空 agentToken，让下一次启动重新注册。
// 只删 agent-state.json 不够：clientId 是主机名+机器码算出来的，会算回同一个值。
// 必须停掉服务再执行，否则运行中的进程会在下次 hello 时把旧身份写回去。
func resetIdentity(configPath string) {
	cfg, err := LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "读取配置失败: %v\n", err)
		os.Exit(1)
	}
	cfg.ClientID = buildClientID() + "-" + randomHex(3)
	cfg.AgentToken = ""
	if err := cfg.SaveState(); err != nil {
		fmt.Fprintf(os.Stderr, "写入 %s 失败: %v\n", filepath.Join(cfg.SpoolDir, "agent-state.json"), err)
		os.Exit(1)
	}
	fmt.Printf("已重置客户端身份: %s\n", cfg.ClientID)
	fmt.Println("如果服务正在运行，请先执行: sc stop OpsHubAgent（Windows）或 systemctl stop ops-hub-agent（Linux），再启动。")
}
