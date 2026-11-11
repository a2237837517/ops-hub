package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	logMaxSize = 10 * 1024 * 1024
	logBackups = 9
)

type Logger struct {
	mu   sync.Mutex
	file *os.File
	path string
}

func NewLogger(cfg *Config) *Logger {
	path := filepath.Join(cfg.SpoolDir, "logs", "agent.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "打开日志失败: %v\n", err)
		return &Logger{path: path}
	}
	return &Logger{file: f, path: path}
}

func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

func (l *Logger) logf(level, format string, args ...any) {
	line := fmt.Sprintf("[%s] [%s] %s\n", time.Now().Format(time.RFC3339), level, fmt.Sprintf(format, args...))
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		if info, err := l.file.Stat(); err == nil && info.Size() >= logMaxSize {
			l.rotateLocked()
		}
		if l.file != nil {
			_, _ = l.file.WriteString(line)
		}
	}
	fmt.Fprint(os.Stderr, line)
}

func (l *Logger) rotateLocked() {
	if l.file == nil {
		return
	}
	_ = l.file.Close()
	_ = os.Remove(fmt.Sprintf("%s.%d", l.path, logBackups+1))
	for i := logBackups - 1; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", l.path, i), fmt.Sprintf("%s.%d", l.path, i+1))
	}
	_ = os.Rename(l.path, l.path+".1")
	if f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		l.file = f
	}
}

func (l *Logger) Infof(format string, args ...any)  { l.logf("INFO", format, args...) }
func (l *Logger) Warnf(format string, args ...any)  { l.logf("WARN", format, args...) }
func (l *Logger) Errorf(format string, args ...any) { l.logf("ERROR", format, args...) }
func (l *Logger) Debugf(format string, args ...any) { l.logf("DEBUG", format, args...) }
