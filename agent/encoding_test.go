package main

import (
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

func TestDecodeBytesUTF8(t *testing.T) {
	text, enc, err := decodeBytes([]byte("中文日志\n"), "auto")
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if text != "中文日志\n" || enc != "utf-8" {
		t.Fatalf("unexpected: %q %q", text, enc)
	}
}

func TestDecodeBytesGBK(t *testing.T) {
	gbk, _, err := transform.Bytes(simplifiedchinese.GBK.NewEncoder(), []byte("中文日志\n"))
	if err != nil {
		t.Fatal(err)
	}
	text, enc, err := decodeBytes(gbk, "auto")
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if text != "中文日志\n" || enc != "gbk" {
		t.Fatalf("unexpected: %q %q", text, enc)
	}
}

func TestEncodeTextGBK(t *testing.T) {
	data, err := encodeText("中文", "gbk")
	if err != nil {
		t.Fatal(err)
	}
	decoded, _, err := transform.Bytes(simplifiedchinese.GBK.NewDecoder(), data)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != "中文" {
		t.Fatalf("unexpected: %q", string(decoded))
	}
}
