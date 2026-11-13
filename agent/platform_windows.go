//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	serviceName        = "OpsHubAgent"
	serviceDisplayName = "Ops Hub Agent"
	serviceDescription = "Ops Hub remote operations agent (outbound WebSocket, no inbound port)"
)

func defaultSpoolDir() string {
	if programData := os.Getenv("ProgramData"); programData != "" {
		return filepath.Join(programData, "OpsHubAgent")
	}
	return `C:\ProgramData\OpsHubAgent`
}

func machineID() string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE)
	if err == nil {
		defer key.Close()
		if value, _, err := key.GetStringValue("MachineGuid"); err == nil && value != "" {
			return value
		}
	}
	hostname, _ := os.Hostname()
	return hostname + "-" + firstMAC()
}

var (
	firmwareUUIDOnce sync.Once
	firmwareUUID     string
)

// firmwareUUIDValue 读取主板/虚拟机的 SMBIOS UUID。整机克隆后 MachineGuid 会重复，
// 但虚拟化平台通常会重新生成 SMBIOS UUID，用它可以把两台机器区分开。
func firmwareUUIDValue() string {
	firmwareUUIDOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "wmic", "csproduct", "get", "uuid", "/value").Output()
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if len(line) > 5 && strings.EqualFold(line[:5], "UUID=") {
				value := strings.TrimSpace(line[5:])
				if value != "" && !strings.EqualFold(value, "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") {
					firmwareUUID = strings.ToUpper(value)
				}
				return
			}
		}
	})
	return firmwareUUID
}

// machineKey 是稳定的机器标识哈希，用于判断 agent-state.json 是否来自本机。
func machineKey() string {
	sum := sha256.Sum256([]byte(machineID()))
	return hex.EncodeToString(sum[:])
}

// machineFingerprint 额外混入 SMBIOS UUID，用来识别整机克隆。
// 拿不到固件 UUID 时返回空串，宁可少一次检测，也不要误判导致重新注册。
func machineFingerprint() string {
	uuid := firmwareUUIDValue()
	if uuid == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(machineID() + "|" + uuid))
	return hex.EncodeToString(sum[:])
}

func firstMAC() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "no-mac"
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback == 0 && iface.HardwareAddr.String() != "" {
			return iface.HardwareAddr.String()
		}
	}
	return "no-mac"
}

func fileIDOf(path string, info os.FileInfo) string {
	f, err := os.Open(path)
	if err != nil {
		return strconv.FormatInt(info.ModTime().UnixNano(), 10)
	}
	defer f.Close()
	var data windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &data); err != nil {
		return strconv.FormatInt(info.ModTime().UnixNano(), 10)
	}
	return fmt.Sprintf("%d:%d:%d", data.VolumeSerialNumber, data.FileIndexHigh, data.FileIndexLow)
}

func killTree(pid int) {
	if pid <= 0 {
		return
	}
	_ = exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
	if process, err := os.FindProcess(pid); err == nil {
		_ = process.Kill()
	}
}

func configureProcess(_ *exec.Cmd) {
	// Windows 下用 taskkill /T 杀进程树；不需要额外 SysProcAttr。
}

func currentUserName() string {
	if user := os.Getenv("USERNAME"); user != "" {
		return user
	}
	return ""
}

func isServiceMode() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

func runService(configPath string) error {
	return svc.Run(serviceName, &serviceHandler{configPath: configPath})
}

type serviceHandler struct {
	configPath string
}

func (h *serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	cfg, err := LoadConfig(h.configPath)
	if err != nil {
		changes <- svc.Status{State: svc.Stopped}
		return false, 1
	}
	logger := NewLogger(cfg)
	if cfg.StateReset {
		logger.Warnf("agent-state.json 来自另一台机器，已丢弃旧身份并重新生成 clientId=%s", cfg.ClientID)
	}
	agent := NewAgent(cfg, logger)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		agent.Run(ctx)
		close(done)
	}()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	go ensureServiceRecovery()
	for request := range requests {
		switch request.Cmd {
		case svc.Interrogate:
			changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			cancel()
			select {
			case <-done:
			case <-time.After(15 * time.Second):
				logger.Warnf("等待 agent 退出超时")
			}
			logger.Close()
			return false, 0
		}
	}
	cancel()
	<-done
	logger.Close()
	return false, 0
}

func installService(configPath string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	absConfig, err := filepath.Abs(configPath)
	if err != nil {
		return err
	}
	if _, err := os.Stat(absConfig); err != nil {
		return fmt.Errorf("配置文件不存在: %s", absConfig)
	}
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("连接服务管理器失败（请用管理员运行）: %w", err)
	}
	defer manager.Disconnect()
	if existing, err := manager.OpenService(serviceName); err == nil {
		existing.Close()
		return fmt.Errorf("服务 %s 已存在，请先 uninstall", serviceName)
	}
	service, err := manager.CreateService(
		serviceName,
		exe,
		mgr.Config{
			DisplayName: serviceDisplayName,
			Description: serviceDescription,
			StartType:   mgr.StartAutomatic,
		},
		"run", "--config", absConfig,
	)
	if err != nil {
		return fmt.Errorf("创建服务失败: %w", err)
	}
	defer service.Close()
	if err := service.Start(); err != nil {
		return fmt.Errorf("启动服务失败: %w", err)
	}
	// 崩溃/异常退出时由 SCM 自动拉起
	if err := exec.Command("sc.exe", "failure", serviceName, "reset=", "86400", "actions=", "restart/5000/restart/10000/restart/30000").Run(); err != nil {
		fmt.Printf("警告: 设置服务自动恢复失败: %v\n", err)
	}
	fmt.Printf("服务 %s 已安装并启动\n", serviceName)
	return nil
}

// ensureServiceRecovery 让老版本安装的服务也具备崩溃自动恢复能力。
// 安装时已经设置过；这里每次启动再设一次，保证“替换 exe 升级”的机器也能修好。
func ensureServiceRecovery() {
	_ = exec.Command(
		"sc.exe", "failure", serviceName,
		"reset=", "86400",
		"actions=", "restart/5000/restart/10000/restart/30000",
	).Run()
}

func uninstallService() error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("连接服务管理器失败（请用管理员运行）: %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("打开服务失败: %w", err)
	}
	defer service.Close()
	_, _ = service.Control(svc.Stop)
	time.Sleep(time.Second)
	if err := service.Delete(); err != nil {
		return fmt.Errorf("删除服务失败: %w", err)
	}
	fmt.Printf("服务 %s 已卸载\n", serviceName)
	return nil
}

func applyUpgrade(exePath, newPath string) error {
	dir := filepath.Dir(exePath)
	helper := filepath.Join(dir, "ops-agent-update.cmd")
	script := fmt.Sprintf(`@echo off
setlocal
timeout /t 3 /nobreak >nul
sc stop %s >nul 2>&1
powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){ if((Get-Service -Name '%s').Status -eq 'Stopped'){ exit 0 }; Start-Sleep -Seconds 2 }; exit 1"
if errorlevel 1 exit /b 1
copy /Y "%s" "%s.bak" >nul 2>&1
copy /Y "%s" "%s" >nul
if errorlevel 1 exit /b 1
del "%s" >nul 2>&1
sc start %s >nul
del "%%~f0"
`, serviceName, serviceName, exePath, exePath, newPath, exePath, newPath, serviceName)
	if err := os.WriteFile(helper, []byte(script), 0o755); err != nil {
		return err
	}
	cmd := exec.Command("cmd.exe", "/c", helper)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
	return cmd.Start()
}
