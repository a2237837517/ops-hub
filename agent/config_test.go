package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeTestConfig(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "config.json")
	data, err := json.Marshal(map[string]any{
		"server":   "ws://127.0.0.1:1/agent",
		"spoolDir": dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeTestState(t *testing.T, dir string, state AgentState) {
	t.Helper()
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "agent-state.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadConfigResetsStateFromAnotherMachine(t *testing.T) {
	dir := t.TempDir()
	writeTestState(t, dir, AgentState{
		ClientID:   "old-machine-aaaaaaaaaa",
		AgentToken: "old-token",
		MachineKey: "deadbeef",
	})

	cfg, err := LoadConfig(writeTestConfig(t, dir))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.StateReset {
		t.Fatal("StateReset should be true for a state file from another machine")
	}
	if cfg.ClientID == "old-machine-aaaaaaaaaa" {
		t.Fatal("clientId should be regenerated")
	}
	if cfg.AgentToken != "" {
		t.Fatal("agent token should be cleared")
	}
}

func TestLoadConfigKeepsStateOnSameMachine(t *testing.T) {
	dir := t.TempDir()
	writeTestState(t, dir, AgentState{
		ClientID:   "this-machine-bbbbbbbbbb",
		AgentToken: "token",
		MachineKey: machineKey(),
	})

	cfg, err := LoadConfig(writeTestConfig(t, dir))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StateReset {
		t.Fatal("StateReset should be false on the same machine")
	}
	if cfg.ClientID != "this-machine-bbbbbbbbbb" {
		t.Fatalf("clientId changed: %s", cfg.ClientID)
	}
	if cfg.AgentToken != "token" {
		t.Fatal("agent token should be kept")
	}
}

func TestLoadConfigKeepsLegacyStateWithoutFingerprint(t *testing.T) {
	dir := t.TempDir()
	writeTestState(t, dir, AgentState{
		ClientID:   "legacy-machine-cccccccccc",
		AgentToken: "token",
	})

	cfg, err := LoadConfig(writeTestConfig(t, dir))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StateReset {
		t.Fatal("legacy state without fingerprint should be kept")
	}
	if cfg.ClientID != "legacy-machine-cccccccccc" {
		t.Fatalf("legacy clientId changed: %s", cfg.ClientID)
	}
}
