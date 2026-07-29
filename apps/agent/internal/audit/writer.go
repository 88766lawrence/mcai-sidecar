package audit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Writer struct {
	mu       sync.Mutex
	path     string
	sequence uint64
	prevHash string
}

type Event struct {
	Sequence  uint64         `json:"seq"`
	At        string         `json:"at"`
	Type      string         `json:"event"`
	TaskID    string         `json:"task_id,omitempty"`
	Summary   string         `json:"summary"`
	Data      map[string]any `json:"data,omitempty"`
	PrevHash  string         `json:"prev_hash"`
	EventHash string         `json:"event_hash"`
}

func New(dataDir string) (*Writer, error) {
	dir := filepath.Join(dataDir, "jobs")
	if err := os.MkdirAll(dir, 0o700); err != nil { return nil, err }
	return &Writer{path: filepath.Join(dir, "audit.jsonl")}, nil
}

func (w *Writer) Append(eventType, taskID, summary string, data map[string]any) (Event, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.sequence++
	event := Event{Sequence: w.sequence, At: time.Now().UTC().Format(time.RFC3339Nano), Type: eventType, TaskID: taskID, Summary: summary, Data: data, PrevHash: w.prevHash}
	unsigned, err := json.Marshal(event); if err != nil { return Event{}, err }
	sum := sha256.Sum256(unsigned)
	event.EventHash = hex.EncodeToString(sum[:])
	line, err := json.Marshal(event); if err != nil { return Event{}, err }
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); if err != nil { return Event{}, fmt.Errorf("open audit log: %w", err) }
	if _, err = f.Write(append(line, '\n')); err == nil { err = f.Sync() }
	closeErr := f.Close()
	if err != nil { return Event{}, err }; if closeErr != nil { return Event{}, closeErr }
	w.prevHash = event.EventHash
	return event, nil
}

