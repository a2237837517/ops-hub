package main

import (
	"os"
	"path/filepath"
	"testing"
)

func testConfig(t *testing.T) *Config {
	t.Helper()
	dir := t.TempDir()
	return &Config{
		SpoolDir:     dir,
		AllowedRoots: []string{dir},
	}
}

func TestFileReadAndTail(t *testing.T) {
	cfg := testConfig(t)
	path := filepath.Join(cfg.SpoolDir, "app.log")
	if err := os.WriteFile(path, []byte("line1\nline2\nline3\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	read, err := fileRead(cfg, FileReadParams{Path: path, Offset: 0, MaxBytes: 100})
	if err != nil {
		t.Fatal(err)
	}
	m := read.(map[string]any)
	if m["content"] != "line1\nline2\nline3\n" {
		t.Fatalf("unexpected content: %q", m["content"])
	}

	tail, err := fileTail(cfg, FileTailParams{Path: path, Lines: 2})
	if err != nil {
		t.Fatal(err)
	}
	tm := tail.(map[string]any)
	lines := tm["lines"].([]map[string]any)
	if len(lines) != 2 || lines[0]["text"] != "line2" || lines[1]["text"] != "line3" {
		t.Fatalf("unexpected tail: %#v", lines)
	}
	cursor := tm["cursor"].(string)

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("line4\n")
	_ = f.Close()

	next, err := fileTail(cfg, FileTailParams{Path: path, Lines: 2, Cursor: cursor})
	if err != nil {
		t.Fatal(err)
	}
	nm := next.(map[string]any)
	nextLines := nm["lines"].([]map[string]any)
	if len(nextLines) != 1 || nextLines[0]["text"] != "line4" {
		t.Fatalf("unexpected next tail: %#v", nextLines)
	}
}

func TestFileSearch(t *testing.T) {
	cfg := testConfig(t)
	path := filepath.Join(cfg.SpoolDir, "app.log")
	if err := os.WriteFile(path, []byte("alpha\nbeta error\ngamma\nerror again\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := fileSearch(cfg, FileSearchParams{
		Path:       path,
		Pattern:    "error",
		Before:     1,
		After:      1,
		MaxMatches: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	m := result.(map[string]any)
	if m["count"].(int) != 2 {
		t.Fatalf("unexpected count: %#v", m)
	}
	matches := m["matches"].([]*SearchMatch)
	if len(matches) != 2 || matches[0].Line != 2 || matches[0].Before[0] != "alpha" {
		t.Fatalf("unexpected matches: %#v", matches)
	}
}

func TestPathAllowed(t *testing.T) {
	cfg := testConfig(t)
	if !cfg.IsPathAllowed(filepath.Join(cfg.SpoolDir, "x", "y.log")) {
		t.Fatal("expected path allowed")
	}
	if cfg.IsPathAllowed(filepath.Join(filepath.Dir(cfg.SpoolDir), "outside.log")) {
		t.Fatal("expected outside path denied")
	}
}

func TestFileWriteEncoding(t *testing.T) {
	cfg := testConfig(t)
	path := filepath.Join(cfg.SpoolDir, "gbk.txt")
	_, err := fileWrite(cfg, FileWriteParams{
		Path:       path,
		Content:    "中文",
		Encoding:   "gbk",
		CreateDirs: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := fileRead(cfg, FileReadParams{Path: path, Offset: 0, MaxBytes: 100})
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["content"] != "中文" {
		t.Fatalf("unexpected read: %#v", result)
	}
}
