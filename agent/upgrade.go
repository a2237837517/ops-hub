package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func (a *Agent) handleUpgrade(msg Incoming) {
	if a.cfg.DisableRemoteUpgrade {
		a.log.Warnf("远程升级已禁用，忽略升级请求")
		return
	}
	if msg.URL == "" || msg.SHA256 == "" {
		a.log.Warnf("升级请求参数不完整")
		return
	}
	serverURL, err := url.Parse(a.cfg.Server)
	if err != nil {
		a.log.Warnf("服务端地址无效: %v", err)
		return
	}
	targetURL, err := url.Parse(msg.URL)
	if err != nil || (targetURL.Scheme != "https" && targetURL.Scheme != "http") {
		a.log.Warnf("升级地址无效: %s", msg.URL)
		return
	}
	if !strings.EqualFold(targetURL.Host, serverURL.Host) {
		a.log.Warnf("拒绝非 Hub 域名的升级地址: %s", msg.URL)
		return
	}

	a.log.Infof("开始下载升级包: %s", msg.URL)
	client := &http.Client{
		Timeout: 10 * time.Minute,
		Transport: &http.Transport{
			Proxy:           a.proxyFunc(),
			TLSClientConfig: a.tlsConfig(),
		},
	}
	resp, err := client.Get(msg.URL)
	if err != nil {
		a.log.Errorf("下载升级包失败: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		a.log.Errorf("下载升级包失败: HTTP %d", resp.StatusCode)
		return
	}

	exePath, err := os.Executable()
	if err != nil {
		a.log.Errorf("获取当前程序路径失败: %v", err)
		return
	}
	newPath := exePath + ".new"
	tmpPath := newPath + ".part"
	file, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		a.log.Errorf("创建升级文件失败: %v", err)
		return
	}

	hasher := sha256.New()
	reader := io.Reader(resp.Body)
	if msg.Size > 0 {
		reader = io.LimitReader(resp.Body, msg.Size+1)
	}
	written, copyErr := io.Copy(io.MultiWriter(file, hasher), reader)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath)
		a.log.Errorf("写入升级文件失败: %v", copyErr)
		return
	}
	if msg.Size > 0 && written > msg.Size {
		_ = os.Remove(tmpPath)
		a.log.Errorf("升级文件超过声明大小")
		return
	}
	sum := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(sum, msg.SHA256) {
		_ = os.Remove(tmpPath)
		a.log.Errorf("升级文件校验失败: got %s want %s", sum, msg.SHA256)
		return
	}
	if err := os.Rename(tmpPath, newPath); err != nil {
		_ = os.Remove(tmpPath)
		a.log.Errorf("保存升级文件失败: %v", err)
		return
	}

	_ = a.send(map[string]any{"type": "agent.upgrade.ready", "version": msg.Version})
	a.log.Infof("升级包校验通过，准备替换并重启: %s", newPath)
	if err := applyUpgrade(exePath, newPath); err != nil {
		a.log.Errorf("启动升级程序失败: %v", err)
		_ = a.send(map[string]any{
			"type":    "agent.upgrade.error",
			"message": fmt.Sprintf("启动升级程序失败: %v", err),
		})
		return
	}
	_ = a.send(map[string]any{"type": "agent.upgrade.started", "version": msg.Version})
	// 让出进程：文件已被替换，退出后由 updater/服务管理器重新拉起。
	time.Sleep(500 * time.Millisecond)
	a.closeConn()
	os.Exit(0)
}
