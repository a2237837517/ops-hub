//go:build linux

package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
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
