//go:build !linux && !windows

package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

func defaultSpoolDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".ops-hub-agent")
	}
	return "/tmp/ops-hub-agent"
}

func machineID() string {
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
	return strconv.FormatInt(info.ModTime().UnixNano(), 10)
}

func killTree(pid int) {
	if pid <= 0 {
		return
	}
	if process, err := os.FindProcess(pid); err == nil {
		_ = process.Kill()
	}
}

func configureProcess(_ *exec.Cmd) {}

func isServiceMode() bool { return false }

func runService(_ string) error {
	return fmt.Errorf("当前平台暂不支持服务模式，请直接 run")
}

func installService(_ string) error {
	return fmt.Errorf("当前平台暂不支持服务安装")
}

func uninstallService() error {
	return fmt.Errorf("当前平台暂不支持服务卸载")
}

func currentUserName() string { return "" }
