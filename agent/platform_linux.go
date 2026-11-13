//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func defaultSpoolDir() string {
	if os.Geteuid() == 0 {
		return "/var/lib/ops-hub-agent"
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".ops-hub-agent")
	}
	return "/tmp/ops-hub-agent"
}

func machineID() string {
	for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if data, err := os.ReadFile(path); err == nil {
			value := string(data)
			if value != "" {
				return value
			}
		}
	}
	hostname, _ := os.Hostname()
	return hostname + "-" + firstMAC()
}

func machineKey() string {
	sum := sha256.Sum256([]byte(machineID()))
	return hex.EncodeToString(sum[:])
}

func machineFingerprint() string {
	return machineKey()
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

func fileIDOf(_ string, info os.FileInfo) string {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)
	}
	return strconv.FormatInt(info.ModTime().UnixNano(), 10)
}

func killTree(pid int) {
	if pid <= 0 {
		return
	}
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
		if process, err := os.FindProcess(pid); err == nil {
			_ = process.Kill()
		}
	}
}

func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func isServiceMode() bool { return false }

func runService(_ string) error {
	return fmt.Errorf("linux 请使用 scripts/install-linux.sh 安装 systemd 服务")
}

func installService(_ string) error {
	return fmt.Errorf("linux 请使用 scripts/install-linux.sh 安装 systemd 服务")
}

func uninstallService() error {
	return fmt.Errorf("linux 请使用 scripts/uninstall-linux.sh 卸载 systemd 服务")
}

func currentUserName() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return ""
}

func applyUpgrade(exePath, newPath string) error {
	// 运行中的二进制不能直接覆盖（ETXTBSY），先改名再放新文件。
	// 服务模式用 systemctl 拉起；前台模式按原命令行重新启动。
	args := strings.Join(os.Args[1:], " ")
	script := fmt.Sprintf(`#!/bin/sh
sleep 3
if systemctl is-enabled --quiet ops-hub-agent 2>/dev/null; then
  systemctl stop ops-hub-agent 2>/dev/null
  mv -f %[1]q %[1]q.bak 2>/dev/null
  mv -f %[2]q %[1]q
  chmod +x %[1]q
  systemctl start ops-hub-agent 2>/dev/null
else
  mv -f %[1]q %[1]q.bak 2>/dev/null
  mv -f %[2]q %[1]q
  chmod +x %[1]q
  nohup %[1]q %[3]s >/dev/null 2>&1 &
fi
rm -f "$0"
`, exePath, newPath, args)
	path := filepath.Join(os.TempDir(), fmt.Sprintf("ops-agent-update-%d.sh", os.Getpid()))
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		return err
	}
	cmd := exec.Command("/bin/sh", path)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start()
}
