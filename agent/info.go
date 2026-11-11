package main

import (
	"net"
	"os/user"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
)

type BasicHostInfo struct {
	OS string
}

func basicHostInfo() BasicHostInfo {
	info := BasicHostInfo{OS: runtime.GOOS}
	if h, err := host.Info(); err == nil {
		parts := []string{h.OS}
		if h.Platform != "" {
			parts = append(parts, h.Platform)
		}
		if h.PlatformVersion != "" {
			parts = append(parts, h.PlatformVersion)
		}
		if len(parts) > 0 {
			info.OS = strings.Join(parts, " ")
		}
	}
	return info
}

func collectInfo(include []string) map[string]any {
	includeSet := make(map[string]bool)
	for _, item := range include {
		includeSet[strings.ToLower(item)] = true
	}
	all := len(includeSet) == 0
	want := func(name string) bool { return all || includeSet[name] }

	result := map[string]any{
		"agentVersion": Version,
		"goVersion":    runtime.Version(),
		"goos":         runtime.GOOS,
		"goarch":       runtime.GOARCH,
		"numCpu":       runtime.NumCPU(),
		"collectedAt":  time.Now().UTC().Format(time.RFC3339),
	}
	if h, err := host.Info(); err == nil {
		result["hostname"] = h.Hostname
		result["os"] = h.OS
		result["platform"] = h.Platform
		result["platformFamily"] = h.PlatformFamily
		result["platformVersion"] = h.PlatformVersion
		result["kernelVersion"] = h.KernelVersion
		result["kernelArch"] = h.KernelArch
		result["uptimeSec"] = h.Uptime
		result["bootTime"] = h.BootTime
		result["procs"] = h.Procs
		result["hostId"] = h.HostID
		result["virtualizationSystem"] = h.VirtualizationSystem
		result["virtualizationRole"] = h.VirtualizationRole
	}
	if want("cpu") {
		if infos, err := cpu.Info(); err == nil && len(infos) > 0 {
			result["cpu"] = map[string]any{
				"model":   infos[0].ModelName,
				"cores":   infos[0].Cores,
				"mhz":     infos[0].Mhz,
				"logical": runtime.NumCPU(),
			}
		}
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		result["memory"] = map[string]any{
			"total":     vm.Total,
			"used":      vm.Used,
			"available": vm.Available,
			"percent":   vm.UsedPercent,
		}
	}
	if want("disks") {
		result["disks"] = collectDisks()
	}
	if want("network") {
		result["network"] = collectNetwork()
	}
	if want("users") {
		result["users"] = collectUsers()
	}
	if avg, err := load.Avg(); err == nil {
		result["load"] = map[string]any{
			"load1":  avg.Load1,
			"load5":  avg.Load5,
			"load15": avg.Load15,
		}
	}
	return result
}

func collectStats() map[string]any {
	result := map[string]any{
		"collectedAt": time.Now().UTC().Format(time.RFC3339),
	}
	if percents, err := cpu.Percent(250*time.Millisecond, false); err == nil && len(percents) > 0 {
		result["cpuPercent"] = percents[0]
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		result["memory"] = map[string]any{
			"total":     vm.Total,
			"used":      vm.Used,
			"available": vm.Available,
			"percent":   vm.UsedPercent,
		}
	}
	if avg, err := load.Avg(); err == nil {
		result["load"] = map[string]any{
			"load1":  avg.Load1,
			"load5":  avg.Load5,
			"load15": avg.Load15,
		}
	}
	if h, err := host.Info(); err == nil {
		result["uptimeSec"] = h.Uptime
	}
	result["disks"] = collectDisks()
	return result
}

func collectDisks() []map[string]any {
	parts, err := disk.Partitions(false)
	if err != nil {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(parts))
	seen := map[string]bool{}
	for _, part := range parts {
		if seen[part.Mountpoint] {
			continue
		}
		switch part.Fstype {
		case "squashfs", "tmpfs", "devtmpfs", "overlay", "proc", "sysfs":
			continue
		}
		if strings.HasPrefix(part.Device, "/dev/loop") {
			continue
		}
		seen[part.Mountpoint] = true
		usage, err := disk.Usage(part.Mountpoint)
		if err != nil {
			continue
		}
		out = append(out, map[string]any{
			"device":     part.Device,
			"mountpoint": part.Mountpoint,
			"fstype":     part.Fstype,
			"total":      usage.Total,
			"free":       usage.Free,
			"used":       usage.Used,
			"percent":    usage.UsedPercent,
		})
		if len(out) >= 30 {
			break
		}
	}
	return out
}

func collectNetwork() []map[string]any {
	ifaces, err := net.Interfaces()
	if err != nil {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(ifaces))
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs := []string{}
		if list, err := iface.Addrs(); err == nil {
			for _, addr := range list {
				addrs = append(addrs, addr.String())
			}
		}
		out = append(out, map[string]any{
			"name":  iface.Name,
			"mac":   iface.HardwareAddr.String(),
			"mtu":   iface.MTU,
			"flags": iface.Flags.String(),
			"addrs": addrs,
		})
	}
	return out
}

func collectUsers() []map[string]any {
	out := []map[string]any{}
	if current, err := user.Current(); err == nil {
		out = append(out, map[string]any{
			"username": current.Username,
			"uid":      current.Uid,
			"gid":      current.Gid,
			"home":     current.HomeDir,
			"current":  true,
		})
	}
	if list, err := host.Users(); err == nil {
		for i, item := range list {
			if i >= 20 {
				break
			}
			out = append(out, map[string]any{
				"username": item.User,
				"terminal": item.Terminal,
				"host":     item.Host,
				"started":  item.Started,
			})
		}
	}
	return out
}
