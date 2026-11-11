package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type FileReadParams struct {
	Path     string `json:"path"`
	Offset   int64  `json:"offset"`
	MaxBytes int64  `json:"maxBytes"`
	Encoding string `json:"encoding"`
}

type FileTailParams struct {
	Path     string `json:"path"`
	Lines    int    `json:"lines"`
	Cursor   string `json:"cursor"`
	Encoding string `json:"encoding"`
}

type TailCursor struct {
	Offset  int64  `json:"offset"`
	FileID  string `json:"fileId"`
	Pending string `json:"pending"`
}

type FileSearchParams struct {
	Path          string `json:"path"`
	Pattern       string `json:"pattern"`
	Regex         bool   `json:"regex"`
	CaseSensitive bool   `json:"caseSensitive"`
	Before        int    `json:"before"`
	After         int    `json:"after"`
	MaxMatches    int    `json:"maxMatches"`
	Encoding      string `json:"encoding"`
}

type FileListParams struct {
	Path       string `json:"path"`
	Pattern    string `json:"pattern"`
	Recursive  bool   `json:"recursive"`
	MaxEntries int    `json:"maxEntries"`
}

type FileStatParams struct {
	Path string `json:"path"`
	Hash bool   `json:"hash"`
}

type FileWriteParams struct {
	Path       string `json:"path"`
	Content    string `json:"content"`
	Encoding   string `json:"encoding"`
	Append     bool   `json:"append"`
	CreateDirs bool   `json:"createDirs"`
}

type FileDeleteParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

type UploadTransfer struct {
	ID         string
	Target     string
	Part       string
	File       *os.File
	Size       int64
	Received   int64
	SHA256     string
	Overwrite  bool
	CreateDirs bool
	Finalizing bool
	mu         sync.Mutex
}

type DownloadTransfer struct {
	ID     string
	Path   string
	File   *os.File
	Size   int64
	Offset int64
	AckCh  chan int64
	Cancel context.CancelFunc
}

func resolvePath(cfg *Config, value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("path 不能为空")
	}
	abs, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	if !cfg.IsPathAllowed(abs) {
		return "", fmt.Errorf("路径不在 allowedRoots 内: %s", abs)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		if !cfg.IsPathAllowed(resolved) {
			return "", fmt.Errorf("路径软链接指向 allowedRoots 之外: %s", resolved)
		}
		return resolved, nil
	}
	if os.IsNotExist(err) {
		parent := filepath.Dir(abs)
		if parentResolved, e := filepath.EvalSymlinks(parent); e == nil {
			if !cfg.IsPathAllowed(parentResolved) {
				return "", fmt.Errorf("父目录不在 allowedRoots 内: %s", parentResolved)
			}
		}
		return abs, nil
	}
	return abs, nil
}

func fileRead(cfg *Config, p FileReadParams) (any, error) {
	path, err := resolvePath(cfg, p.Path)
	if err != nil {
		return nil, err
	}
	stat, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if stat.IsDir() {
		return nil, fmt.Errorf("是目录，不是文件: %s", path)
	}
	offset := p.Offset
	if offset < 0 {
		offset = 0
	}
	if offset > stat.Size() {
		offset = stat.Size()
	}
	maxBytes := p.MaxBytes
	if maxBytes <= 0 {
		maxBytes = 64 * 1024
	}
	if maxBytes > 1024*1024 {
		maxBytes = 1024 * 1024
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	buf := make([]byte, maxBytes)
	n, err := f.Read(buf)
	if err != nil && err != io.EOF {
		return nil, err
	}
	data := buf[:n]
	if offset+int64(n) < stat.Size() {
		trimmed, consumed := trimToLastNewline(data)
		if consumed > 0 {
			data = trimmed
			n = consumed
		}
	}
	if strings.Contains(string(data), "\x00") {
		return nil, fmt.Errorf("二进制文件，请用下载工具: %s", path)
	}
	text, encodingName, decErr := decodeBytes(data, p.Encoding)
	if decErr != nil {
		return nil, decErr
	}
	lines := splitLines(text)
	nextOffset := offset + int64(n)
	return map[string]any{
		"path":       path,
		"offset":     offset,
		"nextOffset": nextOffset,
		"size":       stat.Size(),
		"eof":        nextOffset >= stat.Size(),
		"encoding":   encodingName,
		"lines":      lines,
		"content":    text,
	}, nil
}

func splitLines(text string) []map[string]any {
	raw := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if len(raw) > 0 && raw[len(raw)-1] == "" {
		raw = raw[:len(raw)-1]
	}
	out := make([]map[string]any, 0, len(raw))
	for _, line := range raw {
		if len(line) > 8192 {
			line = line[:8192] + "...[line truncated]"
		}
		out = append(out, map[string]any{"text": line})
	}
	return out
}

func fileTail(cfg *Config, p FileTailParams) (any, error) {
	path, err := resolvePath(cfg, p.Path)
	if err != nil {
		return nil, err
	}
	stat, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if stat.IsDir() {
		return nil, fmt.Errorf("是目录，不是文件: %s", path)
	}
	lines := p.Lines
	if lines <= 0 {
		lines = 200
	}
	if lines > 5000 {
		lines = 5000
	}
	fileID := fileIDOf(path, stat)

	var cursor TailCursor
	if p.Cursor != "" {
		if raw, err := base64.RawURLEncoding.DecodeString(p.Cursor); err == nil {
			_ = json.Unmarshal(raw, &cursor)
		}
	}

	rotated := false
	if cursor.FileID != "" && (cursor.FileID != fileID || stat.Size() < cursor.Offset) {
		rotated = true
		cursor = TailCursor{}
	}

	if cursor.FileID == "" {
		result, err := readLastLines(path, lines, p.Encoding)
		if err != nil {
			return nil, err
		}
		result["path"] = path
		result["size"] = stat.Size()
		result["rotated"] = false
		return result, nil
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(cursor.Offset, io.SeekStart); err != nil {
		return nil, err
	}
	const maxRead = 1024 * 1024
	buf := make([]byte, maxRead)
	n, err := f.Read(buf)
	if err != nil && err != io.EOF {
		return nil, err
	}
	data := buf[:n]
	text, encodingName, decErr := decodeBytes(data, p.Encoding)
	if decErr != nil && len(data) > 0 {
		return nil, decErr
	}
	combined := cursor.Pending + text
	parts := strings.Split(strings.ReplaceAll(combined, "\r\n", "\n"), "\n")
	pending := ""
	if len(parts) > 0 && parts[len(parts)-1] != "" {
		pending = parts[len(parts)-1]
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	outLines := make([]map[string]any, 0, len(parts))
	for _, line := range parts {
		if len(line) > 8192 {
			line = line[:8192] + "...[line truncated]"
		}
		outLines = append(outLines, map[string]any{"text": line})
	}
	cursor = TailCursor{Offset: cursor.Offset + int64(n), FileID: fileID, Pending: pending}
	return map[string]any{
		"path":      path,
		"lines":     outLines,
		"cursor":    encodeCursor(cursor),
		"offset":    cursor.Offset,
		"size":      stat.Size(),
		"encoding":  encodingName,
		"rotated":   rotated,
		"truncated": cursor.Offset < stat.Size(),
	}, nil
}

func readLastLines(path string, lines int, encodingName string) (map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := stat.Size()
	const chunk = 64 * 1024
	start := size
	var data []byte
	newlines := 0
	for start > 0 && newlines <= lines && int64(len(data)) < 4*1024*1024 {
		step := int64(chunk)
		if start < step {
			step = start
		}
		start -= step
		buf := make([]byte, step)
		if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
			return nil, err
		}
		data = append(buf, data...)
		newlines = strings.Count(string(data), "\n")
	}
	text, enc, err := decodeBytes(data, encodingName)
	if err != nil && len(data) > 0 {
		return nil, err
	}
	parts := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	pending := ""
	if len(parts) > 0 && parts[len(parts)-1] != "" {
		pending = parts[len(parts)-1]
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	out := make([]map[string]any, 0, len(parts))
	for _, line := range parts {
		if len(line) > 8192 {
			line = line[:8192] + "...[line truncated]"
		}
		out = append(out, map[string]any{"text": line})
	}
	cursor := TailCursor{Offset: size, FileID: fileIDOf(path, stat), Pending: pending}
	return map[string]any{
		"lines":    out,
		"cursor":   encodeCursor(cursor),
		"offset":   size,
		"size":     size,
		"encoding": enc,
	}, nil
}

func encodeCursor(cursor TailCursor) string {
	raw, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func fileSearch(cfg *Config, p FileSearchParams) (any, error) {
	path, err := resolvePath(cfg, p.Path)
	if err != nil {
		return nil, err
	}
	if p.Pattern == "" {
		return nil, fmt.Errorf("pattern 不能为空")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	maxMatches := p.MaxMatches
	if maxMatches <= 0 {
		maxMatches = 50
	}
	if maxMatches > 1000 {
		maxMatches = 1000
	}
	beforeN := p.Before
	if beforeN < 0 {
		beforeN = 0
	}
	if beforeN > 50 {
		beforeN = 50
	}
	afterN := p.After
	if afterN < 0 {
		afterN = 0
	}
	if afterN > 50 {
		afterN = 50
	}

	var re *regexp.Regexp
	if p.Regex {
		expr := p.Pattern
		if !p.CaseSensitive {
			expr = "(?i)" + expr
		}
		re, err = regexp.Compile(expr)
		if err != nil {
			return nil, fmt.Errorf("正则无效: %w", err)
		}
	}
	needle := p.Pattern
	if !p.CaseSensitive {
		needle = strings.ToLower(needle)
	}

	reader := newDecodedReader(f, p.Encoding)
	br := bufio.NewReaderSize(reader, 64*1024)
	var ring []string
	var pendingAfter []*SearchMatch
	matches := make([]*SearchMatch, 0, maxMatches)
	lineNo := 0
	scanned := int64(0)
	truncated := false

	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			scanned += int64(len(line))
			lineNo++
			text := strings.TrimRight(line, "\r\n")
			if len(text) > 8192 {
				text = text[:8192] + "...[line truncated]"
			}
			// 填充之前匹配的 after 上下文
			for _, match := range pendingAfter {
				if match.Remaining > 0 {
					match.After = append(match.After, text)
					match.Remaining--
				}
			}
			filtered := pendingAfter[:0]
			for _, match := range pendingAfter {
				if match.Remaining > 0 {
					filtered = append(filtered, match)
				}
			}
			pendingAfter = filtered

			matched := false
			if re != nil {
				matched = re.MatchString(text)
			} else if p.CaseSensitive {
				matched = strings.Contains(text, needle)
			} else {
				matched = strings.Contains(strings.ToLower(text), needle)
			}
			if matched {
				m := &SearchMatch{
					Line:      lineNo,
					Text:      text,
					Before:    append([]string(nil), ring...),
					Remaining: afterN,
				}
				matches = append(matches, m)
				if afterN > 0 {
					pendingAfter = append(pendingAfter, m)
				}
				if len(matches) >= maxMatches {
					truncated = true
					break
				}
			}
			ring = append(ring, text)
			if len(ring) > beforeN {
				ring = ring[len(ring)-beforeN:]
			}
		}
		if err != nil {
			break
		}
		if scanned > 128*1024*1024 {
			truncated = true
			break
		}
	}
	return map[string]any{
		"path":      path,
		"matches":   matches,
		"count":     len(matches),
		"truncated": truncated,
		"scanned":   scanned,
		"encoding":  p.Encoding,
	}, nil
}

type SearchMatch struct {
	Line      int      `json:"line"`
	Text      string   `json:"text"`
	Before    []string `json:"before,omitempty"`
	After     []string `json:"after,omitempty"`
	Remaining int      `json:"-"`
}

func fileList(cfg *Config, p FileListParams) (any, error) {
	path, err := resolvePath(cfg, p.Path)
	if err != nil {
		return nil, err
	}
	maxEntries := p.MaxEntries
	if maxEntries <= 0 {
		maxEntries = 500
	}
	if maxEntries > 5000 {
		maxEntries = 5000
	}
	pattern := p.Pattern
	if pattern == "" {
		pattern = "*"
	}
	entries := make([]map[string]any, 0, 64)
	appendEntry := func(path string, info os.FileInfo) bool {
		if pattern != "*" {
			ok, _ := filepath.Match(pattern, info.Name())
			if !ok {
				return true
			}
		}
		entries = append(entries, map[string]any{
			"name":    info.Name(),
			"path":    path,
			"dir":     info.IsDir(),
			"size":    info.Size(),
			"modTime": info.ModTime().Format(time.RFC3339),
		})
		return len(entries) < maxEntries
	}

	stat, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !stat.IsDir() {
		appendEntry(path, stat)
	} else if p.Recursive {
		_ = filepath.Walk(path, func(current string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if current == path {
				return nil
			}
			if info.IsDir() && strings.Count(strings.TrimPrefix(current, path), string(os.PathSeparator)) > 8 {
				return filepath.SkipDir
			}
			if !appendEntry(current, info) {
				return filepath.SkipAll
			}
			return nil
		})
	} else {
		dirEntries, err := os.ReadDir(path)
		if err != nil {
			return nil, err
		}
		for _, entry := range dirEntries {
			info, err := entry.Info()
			if err != nil {
				continue
			}
			if !appendEntry(filepath.Join(path, entry.Name()), info) {
				break
			}
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		di, _ := entries[i]["dir"].(bool)
		dj, _ := entries[j]["dir"].(bool)
		if di != dj {
			return di
		}
		return strings.ToLower(fmt.Sprint(entries[i]["name"])) < strings.ToLower(fmt.Sprint(entries[j]["name"]))
	})
	return map[string]any{
		"path":      path,
		"entries":   entries,
		"count":     len(entries),
		"truncated": len(entries) >= maxEntries,
	}, nil
}

func fileStat(cfg *Config, p FileStatParams) (any, error) {
	path, err := resolvePath(cfg, p.Path)
	if err != nil {
		return nil, err
	}
	stat, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	result := map[string]any{
		"path":    path,
		"name":    stat.Name(),
		"dir":     stat.IsDir(),
		"size":    stat.Size(),
		"mode":    stat.Mode().String(),
		"modTime": stat.ModTime().Format(time.RFC3339),
	}
	if p.Hash && !stat.IsDir() {
		hash, err := sha256File(path)
		if err != nil {
			return nil, err
		}
		result["sha256"] = hash
	}
	return result, nil
}

func fileWrite(cfg *Config, p FileWriteParams) (any, error) {
	if int64(len(p.Content)) > 4*1024*1024 {
		return nil, fmt.Errorf("content 过大，最大 4MB；大文件请用上传")
	}
	path, err := resolvePath(cfg, p.Path)
	if err != nil {
		return nil, err
	}
	if p.CreateDirs {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
	}
	data, err := encodeText(p.Content, p.Encoding)
	if err != nil {
		return nil, err
	}
	if p.Append {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		if _, err := f.Write(data); err != nil {
			return nil, err
		}
	} else {
		tmp := path + ".tmp-" + randomHex(4)
		if err := os.WriteFile(tmp, data, 0o644); err != nil {
			return nil, err
		}
		if err := os.Rename(tmp, path); err != nil {
			_ = os.Remove(tmp)
			return nil, err
		}
	}
	return map[string]any{
		"path":     path,
		"bytes":    len(data),
		"encoding": p.Encoding,
		"append":   p.Append,
	}, nil
}

func fileDelete(cfg *Config, p FileDeleteParams) (any, error) {
	path, err := resolvePath(cfg, p.Path)
	if err != nil {
		return nil, err
	}
	stat, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if isProtectedDeletePath(path) {
		return nil, fmt.Errorf("拒绝删除受保护路径: %s", path)
	}
	if stat.IsDir() && !p.Recursive {
		return nil, fmt.Errorf("删除目录需要 recursive=true: %s", path)
	}
	if stat.IsDir() {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if err != nil {
		return nil, err
	}
	kind := "file"
	if stat.IsDir() {
		kind = "dir"
	}
	return map[string]any{
		"path":      path,
		"type":      kind,
		"recursive": p.Recursive,
		"deleted":   true,
	}, nil
}

func isProtectedDeletePath(path string) bool {
	clean := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		volume := filepath.VolumeName(clean)
		if volume == "" {
			return false
		}
		root := strings.TrimRight(volume, `\/`) + `\`
		if strings.EqualFold(clean, root) || strings.EqualFold(clean, strings.TrimRight(volume, `\/`)) {
			return true
		}
		protected := []string{
			`C:\Windows`,
			`C:\Program Files`,
			`C:\Program Files (x86)`,
			`C:\ProgramData`,
			`C:\Users`,
		}
		for _, item := range protected {
			if strings.EqualFold(clean, item) {
				return true
			}
		}
		return false
	}
	protected := map[string]bool{
		"/": true, "/bin": true, "/boot": true, "/dev": true, "/etc": true,
		"/home": true, "/lib": true, "/lib64": true, "/opt": true, "/proc": true,
		"/root": true, "/sbin": true, "/sys": true, "/usr": true, "/var": true,
	}
	return protected[clean]
}

func (a *Agent) startUpload(msg Incoming) {
	target, err := resolvePath(a.cfg, msg.Path)
	if err != nil {
		a.sendUploadError(msg.TransferID, err)
		return
	}
	if msg.CreateDirs {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			a.sendUploadError(msg.TransferID, err)
			return
		}
	}
	if !msg.Overwrite {
		if _, err := os.Stat(target); err == nil {
			a.sendUploadError(msg.TransferID, fmt.Errorf("目标已存在: %s", target))
			return
		}
	}
	part := target + ".opshubpart"
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		a.sendUploadError(msg.TransferID, err)
		return
	}
	tr := &UploadTransfer{
		ID:         msg.TransferID,
		Target:     target,
		Part:       part,
		File:       f,
		Size:       msg.Size,
		SHA256:     msg.SHA256,
		Overwrite:  msg.Overwrite,
		CreateDirs: msg.CreateDirs,
	}
	a.uploadsMu.Lock()
	a.uploads[tr.ID] = tr
	a.uploadsMu.Unlock()
	_ = a.send(map[string]any{
		"type":       "file.upload.ready",
		"transferId": tr.ID,
		"offset":     0,
	})
	if tr.Size == 0 {
		tr.Finalizing = true
		go a.finalizeUpload(tr)
	}
}

func (a *Agent) uploadChunk(msg Incoming) {
	a.uploadsMu.Lock()
	tr := a.uploads[msg.TransferID]
	a.uploadsMu.Unlock()
	if tr == nil {
		a.sendUploadError(msg.TransferID, fmt.Errorf("upload transfer not found"))
		return
	}
	data, err := base64.StdEncoding.DecodeString(msg.Data)
	if err != nil {
		a.sendUploadError(msg.TransferID, err)
		return
	}
	tr.mu.Lock()
	if tr.Finalizing {
		tr.mu.Unlock()
		return
	}
	if _, err := tr.File.WriteAt(data, msg.Offset); err != nil {
		tr.mu.Unlock()
		a.sendUploadError(msg.TransferID, err)
		return
	}
	tr.Received = msg.Offset + int64(len(data))
	received := tr.Received
	size := tr.Size
	tr.mu.Unlock()

	_ = a.send(map[string]any{
		"type":       "file.upload.ack",
		"transferId": tr.ID,
		"received":   received,
	})
	if size > 0 && received >= size {
		tr.mu.Lock()
		tr.Finalizing = true
		tr.mu.Unlock()
		go a.finalizeUpload(tr)
	}
}

func (a *Agent) finalizeUpload(tr *UploadTransfer) {
	tr.mu.Lock()
	err := tr.File.Sync()
	if err == nil {
		err = tr.File.Close()
	}
	tr.mu.Unlock()
	if err == nil {
		var stat os.FileInfo
		stat, err = os.Stat(tr.Part)
		if err == nil && stat.Size() != tr.Size {
			err = fmt.Errorf("大小不一致: %d != %d", stat.Size(), tr.Size)
		}
	}
	var hash string
	if err == nil {
		hash, err = sha256File(tr.Part)
	}
	if err == nil && tr.SHA256 != "" && hash != tr.SHA256 {
		err = fmt.Errorf("sha256 不一致")
	}
	if err == nil {
		if tr.Overwrite {
			_ = os.Remove(tr.Target)
		}
		err = os.Rename(tr.Part, tr.Target)
	}
	a.uploadsMu.Lock()
	delete(a.uploads, tr.ID)
	a.uploadsMu.Unlock()
	if err != nil {
		a.sendUploadError(tr.ID, err)
		return
	}
	_ = a.send(map[string]any{
		"type":       "file.upload.done",
		"transferId": tr.ID,
		"size":       tr.Size,
		"sha256":     hash,
	})
}

func (a *Agent) sendUploadError(transferID string, err error) {
	a.uploadsMu.Lock()
	tr := a.uploads[transferID]
	delete(a.uploads, transferID)
	a.uploadsMu.Unlock()
	if tr != nil {
		tr.mu.Lock()
		_ = tr.File.Close()
		tr.mu.Unlock()
		_ = os.Remove(tr.Part)
	}
	_ = a.send(map[string]any{
		"type":       "file.upload.error",
		"transferId": transferID,
		"message":    err.Error(),
	})
}

func (a *Agent) startDownload(msg Incoming) {
	path, err := resolvePath(a.cfg, msg.Path)
	if err != nil {
		a.sendDownloadError(msg.TransferID, err)
		return
	}
	stat, err := os.Stat(path)
	if err != nil {
		a.sendDownloadError(msg.TransferID, err)
		return
	}
	if stat.IsDir() {
		a.sendDownloadError(msg.TransferID, fmt.Errorf("是目录，不能下载: %s", path))
		return
	}
	f, err := os.Open(path)
	if err != nil {
		a.sendDownloadError(msg.TransferID, err)
		return
	}
	if msg.Offset > 0 {
		if _, err := f.Seek(msg.Offset, io.SeekStart); err != nil {
			_ = f.Close()
			a.sendDownloadError(msg.TransferID, err)
			return
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	tr := &DownloadTransfer{
		ID:     msg.TransferID,
		Path:   path,
		File:   f,
		Size:   stat.Size(),
		Offset: msg.Offset,
		AckCh:  make(chan int64, 1),
		Cancel: cancel,
	}
	a.downMu.Lock()
	a.downloads[tr.ID] = tr
	a.downMu.Unlock()
	go a.runDownload(ctx, tr)
}

func (a *Agent) runDownload(ctx context.Context, tr *DownloadTransfer) {
	defer func() {
		_ = tr.File.Close()
		a.downMu.Lock()
		delete(a.downloads, tr.ID)
		a.downMu.Unlock()
	}()
	hash := sha256.New()
	// 如果从 offset 续传，先把前面的内容读一遍计算整体 hash 不现实；
	// 当前只支持从 0 开始，offset > 0 时 hash 仅代表剩余部分。
	if tr.Offset > 0 {
		hash.Reset()
	}
	buf := make([]byte, 256*1024)
	offset := tr.Offset
	for {
		n, err := tr.File.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if tr.Offset == 0 {
				hash.Write(chunk)
			}
			if sendErr := a.send(map[string]any{
				"type":       "file.download.chunk",
				"transferId": tr.ID,
				"offset":     offset,
				"data":       base64.StdEncoding.EncodeToString(chunk),
			}); sendErr != nil {
				a.sendDownloadError(tr.ID, sendErr)
				return
			}
			select {
			case <-tr.AckCh:
			case <-time.After(60 * time.Second):
				a.sendDownloadError(tr.ID, fmt.Errorf("等待 hub ack 超时"))
				return
			case <-ctx.Done():
				return
			}
			offset += int64(n)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			a.sendDownloadError(tr.ID, err)
			return
		}
	}
	sum := ""
	if tr.Offset == 0 {
		sum = hex.EncodeToString(hash.Sum(nil))
	}
	_ = a.send(map[string]any{
		"type":       "file.download.done",
		"transferId": tr.ID,
		"size":       tr.Size,
		"sha256":     sum,
	})
}

func (a *Agent) downloadAck(transferID string) {
	a.downMu.Lock()
	tr := a.downloads[transferID]
	a.downMu.Unlock()
	if tr == nil {
		return
	}
	select {
	case tr.AckCh <- 1:
	default:
	}
}

func (a *Agent) cancelDownload(transferID string) {
	a.downMu.Lock()
	tr := a.downloads[transferID]
	a.downMu.Unlock()
	if tr != nil {
		tr.Cancel()
	}
}

func (a *Agent) sendDownloadError(transferID string, err error) {
	a.downMu.Lock()
	tr := a.downloads[transferID]
	a.downMu.Unlock()
	if tr != nil {
		tr.Cancel()
	}
	_ = a.send(map[string]any{
		"type":       "file.download.error",
		"transferId": transferID,
		"message":    err.Error(),
	})
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
