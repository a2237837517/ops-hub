package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

var (
	utf8BOM    = []byte{0xEF, 0xBB, 0xBF}
	utf16LEBOM = []byte{0xFF, 0xFE}
	utf16BEBOM = []byte{0xFE, 0xFF}
)

func newDecodedReader(r io.Reader, explicit string) io.Reader {
	br := bufio.NewReaderSize(r, 16*1024)
	enc := strings.ToLower(strings.TrimSpace(explicit))
	if enc != "" && enc != "auto" {
		if dec := decoderFor(enc); dec != nil {
			return transform.NewReader(br, dec)
		}
	}
	// 只做一次非阻塞嗅探：Pipe 的 Read 返回当前可用数据，不会等满 4KB。
	peek := make([]byte, 4096)
	n, _ := br.Read(peek)
	if n <= 0 {
		return br
	}
	peek = peek[:n]
	reader := io.MultiReader(bytes.NewReader(peek), br)

	if bytes.HasPrefix(peek, utf16LEBOM) || bytes.HasPrefix(peek, utf16BEBOM) {
		order := unicode.LittleEndian
		if bytes.HasPrefix(peek, utf16BEBOM) {
			order = unicode.BigEndian
		}
		return transform.NewReader(reader, unicode.UTF16(order, unicode.UseBOM).NewDecoder())
	}
	if bytes.HasPrefix(peek, utf8BOM) {
		return io.MultiReader(bytes.NewReader(peek[len(utf8BOM):]), br)
	}
	if !validUTF8Prefix(peek) {
		return transform.NewReader(reader, simplifiedchinese.GBK.NewDecoder())
	}
	return reader
}

func decoderFor(name string) *encoding.Decoder {
	switch strings.ToLower(name) {
	case "utf-8", "utf8":
		return encoding.Nop.NewDecoder()
	case "gbk":
		return simplifiedchinese.GBK.NewDecoder()
	case "gb18030":
		return simplifiedchinese.GB18030.NewDecoder()
	case "utf-16le", "utf16le":
		return unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder()
	case "utf-16be", "utf16be":
		return unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder()
	default:
		return nil
	}
}

func validUTF8Prefix(buf []byte) bool {
	// 末尾可能是被截断的多字节字符，先退到字符边界再判断
	end := len(buf)
	for i := 0; i < 4 && end > 0; i++ {
		if utf8.Valid(buf[:end]) {
			return true
		}
		if buf[end-1]&0xC0 == 0x80 || buf[end-1] >= 0xC0 {
			end--
			continue
		}
		break
	}
	return utf8.Valid(buf[:end])
}

func decodeBytes(data []byte, explicit string) (string, string, error) {
	if explicit != "" && explicit != "auto" {
		if dec := decoderFor(explicit); dec != nil {
			out, _, err := transform.Bytes(dec, data)
			return string(out), explicit, err
		}
	}
	if bytes.HasPrefix(data, utf16LEBOM) || bytes.HasPrefix(data, utf16BEBOM) {
		order := unicode.LittleEndian
		if bytes.HasPrefix(data, utf16BEBOM) {
			order = unicode.BigEndian
		}
		out, _, err := transform.Bytes(unicode.UTF16(order, unicode.UseBOM).NewDecoder(), data)
		return string(out), "utf-16le", err
	}
	if bytes.HasPrefix(data, utf8BOM) {
		data = data[len(utf8BOM):]
	}
	if utf8.Valid(data) {
		return string(data), "utf-8", nil
	}
	out, _, err := transform.Bytes(simplifiedchinese.GBK.NewDecoder(), data)
	if err != nil {
		return string(data), "binary", fmt.Errorf("decode failed: %w", err)
	}
	return string(out), "gbk", nil
}

func encodeText(text, encodingName string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(encodingName)) {
	case "", "utf-8", "utf8":
		return []byte(text), nil
	case "gbk":
		out, _, err := transform.Bytes(simplifiedchinese.GBK.NewEncoder(), []byte(text))
		return out, err
	case "gb18030":
		out, _, err := transform.Bytes(simplifiedchinese.GB18030.NewEncoder(), []byte(text))
		return out, err
	case "utf-16le", "utf16le":
		out, _, err := transform.Bytes(unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewEncoder(), []byte(text))
		return out, err
	default:
		return nil, fmt.Errorf("unsupported encoding: %s", encodingName)
	}
}

func trimToLastNewline(data []byte) ([]byte, int) {
	for i := len(data) - 1; i >= 0; i-- {
		if data[i] == '\n' {
			return data[:i+1], i + 1
		}
	}
	return data, len(data)
}
