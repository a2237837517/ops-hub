package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const frameHeaderSize = 13

type Job struct {
	ID        string
	SpoolPath string
	Spool     *os.File
	Command   string
	Shell     string
	Cwd       string

	mu         sync.Mutex
	offset     int64
	frameStart int64
	seq        int64
	lastStream string
	done       bool
	exitCode   int
	signal     string
	error      string
	cancelled  bool
	truncated  bool
	bytes      int64
	maxOutput  int64
	startedAt  time.Time
	endedAt    string

	ctx    context.Context
	cancel context.CancelFunc
	cmd    *exec.Cmd
	doneCh chan struct{}
	once   sync.Once
}

func (a *Agent) activeJobCount() int {
	a.jobsMu.Lock()
	defer a.jobsMu.Unlock()
	count := 0
	for _, job := range a.jobs {
		job.mu.Lock()
		if !job.done {
			count++
		}
		job.mu.Unlock()
	}
	return count
}

func (a *Agent) startExec(msg Incoming) {
	if a.activeJobCount() >= a.cfg.MaxConcurrentJobs {
		_ = a.send(map[string]any{
			"type":    "exec.error",
			"jobId":   msg.JobID,
			"message": fmt.Sprintf("agent 并发任务已达上限 %d", a.cfg.MaxConcurrentJobs),
		})
		return
	}

	spoolPath := filepath.Join(a.cfg.SpoolDir, "jobs", sanitizeID(msg.JobID)+".spool")
	spool, err := os.OpenFile(spoolPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		_ = a.send(map[string]any{"type": "exec.error", "jobId": msg.JobID, "message": err.Error()})
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	job := &Job{
		ID:        msg.JobID,
		SpoolPath: spoolPath,
		Spool:     spool,
		Command:   msg.Command,
		Shell:     msg.Shell,
		Cwd:       msg.Cwd,
		maxOutput: msg.MaxOutputBytes,
		ctx:       ctx,
		cancel:    cancel,
		startedAt: time.Now(),
		doneCh:    make(chan struct{}),
	}
	if job.maxOutput <= 0 {
		job.maxOutput = 50 * 1024 * 1024
	}
	a.putJob(job)

	cmd := buildCommand(msg)
	cmd.Dir = msg.Cwd
	configureProcess(cmd)
	cmd.Env = os.Environ()
	for key, value := range msg.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		a.failJob(job, err)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		a.failJob(job, err)
		return
	}
	if err := cmd.Start(); err != nil {
		a.failJob(job, err)
		return
	}
	job.mu.Lock()
	job.cmd = cmd
	job.mu.Unlock()

	_ = a.send(map[string]any{
		"type":      "exec.started",
		"jobId":     job.ID,
		"pid":       cmd.Process.Pid,
		"startedAt": job.startedAt.UTC().Format(time.RFC3339Nano),
	})

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a.pump(job, "stdout", stdout) }()
	go func() { defer wg.Done(); a.pump(job, "stderr", stderr) }()

	timeout := time.Duration(msg.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 24 * time.Hour
	}
	go func() {
		select {
		case <-time.After(timeout):
			job.mu.Lock()
			if !job.done {
				job.error = "timeout"
				job.cancelled = true
			}
			job.mu.Unlock()
			job.cancel()
			killTree(cmd.Process.Pid)
		case <-ctx.Done():
			killTree(cmd.Process.Pid)
		case <-job.doneCh:
			return
		}
	}()

	go func() {
		err := cmd.Wait()
		wg.Wait()
		job.mu.Lock()
		job.done = true
		job.endedAt = time.Now().UTC().Format(time.RFC3339Nano)
		exitCode := 0
		if cmd.ProcessState != nil {
			exitCode = cmd.ProcessState.ExitCode()
		}
		if err != nil && exitCode == 0 {
			exitCode = -1
			job.error = err.Error()
		}
		job.exitCode = exitCode
		job.signal = ""
		cancelled := job.cancelled
		jobErr := job.error
		endedAt := job.endedAt
		job.mu.Unlock()
		job.once.Do(func() { close(job.doneCh) })

		_ = a.send(map[string]any{
			"type":      "exec.exit",
			"jobId":     job.ID,
			"exitCode":  exitCode,
			"signal":    "",
			"cancelled": cancelled,
			"error":     jobErr,
			"endedAt":   endedAt,
		})
		_ = job.Spool.Close()

		// 保留一段时间供断线重连补发，后续清理
		go func() {
			time.Sleep(10 * time.Minute)
			a.deleteJob(job.ID)
			_ = os.Remove(job.SpoolPath)
		}()
	}()
}

func buildCommand(msg Incoming) *exec.Cmd {
	shell := strings.ToLower(msg.Shell)
	if runtime.GOOS == "windows" {
		if shell == "powershell" || shell == "pwsh" {
			return exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", msg.Command)
		}
		return exec.Command("cmd.exe", "/d", "/s", "/c", msg.Command)
	}
	if shell == "sh" {
		return exec.Command("/bin/sh", "-c", msg.Command)
	}
	return exec.Command("/bin/bash", "-lc", msg.Command)
}

func (a *Agent) pump(job *Job, stream string, r io.Reader) {
	reader := newDecodedReader(r, "auto")
	buf := make([]byte, 32*1024)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			job.append(a, stream, buf[:n])
		}
		if err != nil {
			if err != io.EOF {
				a.log.Debugf("job %s %s read: %v", job.ID, stream, err)
			}
			return
		}
	}
}

func (j *Job) append(a *Agent, stream string, data []byte) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.done {
		return
	}
	if j.bytes+int64(len(data)) > j.maxOutput {
		if !j.truncated {
			j.truncated = true
			marker := []byte("\n[output truncated by agent]\n")
			j.writeFrameLocked(stream, marker)
			a.sendChunk(j.ID, j.frameStart, j.offset, j.seq-1, stream, marker, true)
		}
		return
	}
	start := j.offset
	seq := j.seq
	j.writeFrameLocked(stream, data)
	j.bytes += int64(len(data))
	end := j.offset
	a.sendChunk(j.ID, start, end, seq, stream, data, j.truncated)
}

// writeFrameLocked 需要持有 j.mu。
func (j *Job) writeFrameLocked(stream string, data []byte) {
	streamByte := byte(1)
	if stream == "stderr" {
		streamByte = 2
	}
	header := make([]byte, frameHeaderSize)
	header[0] = streamByte
	binary.BigEndian.PutUint64(header[1:9], uint64(j.seq))
	binary.BigEndian.PutUint32(header[9:13], uint32(len(data)))
	j.frameStart = j.offset
	if _, err := j.Spool.Write(header); err != nil {
		return
	}
	if _, err := j.Spool.Write(data); err != nil {
		return
	}
	j.offset += int64(frameHeaderSize + len(data))
	j.seq++
}

func (a *Agent) failJob(job *Job, err error) {
	job.mu.Lock()
	job.done = true
	job.error = err.Error()
	job.exitCode = -1
	job.endedAt = time.Now().UTC().Format(time.RFC3339Nano)
	job.mu.Unlock()
	job.once.Do(func() { close(job.doneCh) })
	_ = job.Spool.Close()
	_ = a.send(map[string]any{
		"type":    "exec.error",
		"jobId":   job.ID,
		"message": err.Error(),
	})
}

func (a *Agent) cancelJob(jobID string) {
	job := a.getJob(jobID)
	if job == nil {
		return
	}
	job.mu.Lock()
	if job.done {
		job.mu.Unlock()
		return
	}
	job.cancelled = true
	job.mu.Unlock()
	job.cancel()
	job.mu.Lock()
	pid := 0
	if job.cmd != nil && job.cmd.Process != nil {
		pid = job.cmd.Process.Pid
	}
	job.mu.Unlock()
	if pid > 0 {
		killTree(pid)
	}
	a.log.Infof("job %s cancelled", jobID)
}

func (a *Agent) resumeJob(jobID string, offset int64) {
	job := a.getJob(jobID)
	if job == nil {
		_ = a.send(map[string]any{"type": "exec.lost", "jobId": jobID})
		return
	}
	f, err := os.Open(job.SpoolPath)
	if err != nil {
		_ = a.send(map[string]any{"type": "exec.lost", "jobId": jobID})
		return
	}
	defer f.Close()
	if offset < 0 {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return
	}
	header := make([]byte, frameHeaderSize)
	for {
		if _, err := io.ReadFull(f, header); err != nil {
			break
		}
		stream := "stdout"
		if header[0] == 2 {
			stream = "stderr"
		}
		seq := int64(binary.BigEndian.Uint64(header[1:9]))
		length := int(binary.BigEndian.Uint32(header[9:13]))
		if length < 0 || length > 64*1024*1024 {
			break
		}
		data := make([]byte, length)
		if _, err := io.ReadFull(f, data); err != nil {
			break
		}
		start := offset
		offset += int64(frameHeaderSize + length)
		a.sendChunk(jobID, start, offset, seq, stream, data, false)
	}
	job.mu.Lock()
	done := job.done
	exitCode := job.exitCode
	endedAt := job.endedAt
	jobErr := job.error
	cancelled := job.cancelled
	job.mu.Unlock()
	if done {
		_ = a.send(map[string]any{
			"type":      "exec.exit",
			"jobId":     jobID,
			"exitCode":  exitCode,
			"cancelled": cancelled,
			"error":     jobErr,
			"endedAt":   endedAt,
		})
	}
}
