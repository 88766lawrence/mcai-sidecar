package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/mcai/sidecar-agent/internal/identity"
)

const SchemaVersion = "agent-message/v1"

type Envelope struct {
	SchemaVersion string          `json:"schema_version"`
	MessageID     string          `json:"message_id"`
	Timestamp     string          `json:"timestamp"`
	Nonce         string          `json:"nonce"`
	TenantID      string          `json:"tenant_id"`
	AgentID       string          `json:"agent_id"`
	Type          string          `json:"type"`
	Payload       json.RawMessage `json:"payload"`
	Signature     string          `json:"signature,omitempty"`
}

type TaskPlan struct {
	SchemaVersion     string           `json:"schema_version"`
	TaskID            string           `json:"task_id"`
	InstanceRef       string           `json:"instance_ref"`
	Intent            string           `json:"intent"`
	InventoryRevision string           `json:"inventory_revision"`
	Steps             []TaskStep       `json:"steps"`
	Acceptance        []AcceptanceRule `json:"acceptance"`
}

type TaskStep struct {
	ID                   string         `json:"id"`
	Tool                 string         `json:"tool"`
	Args                 map[string]any `json:"args"`
	Risk                 string         `json:"risk"`
	RequiresConfirmation bool           `json:"requires_confirmation"`
}
type AcceptanceRule struct {
	Type     string `json:"type"`
	Expected string `json:"expected,omitempty"`
	Pattern  string `json:"pattern,omitempty"`
	Name     string `json:"name,omitempty"`
}

func NewEnvelope(id *identity.Identity, tenantID, messageID, nonce, messageType string, payload any) (Envelope, error) {
	raw, err := marshalPayload(payload)
	if err != nil {
		return Envelope{}, err
	}
	e := Envelope{SchemaVersion: SchemaVersion, MessageID: messageID, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), Nonce: nonce, TenantID: tenantID, AgentID: id.AgentID, Type: messageType, Payload: raw}
	e.Signature = id.Sign([]byte(e.Canonical()))
	return e, nil
}

// JSON.stringify does not HTML-escape <, >, or &, so the Sidecar must use
// the same representation before hashing payloads for Cloud verification.
func marshalPayload(payload any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func (e Envelope) Canonical() string {
	sum := sha256.Sum256(e.Payload)
	return strings.Join([]string{e.MessageID, e.Timestamp, e.Nonce, e.TenantID, e.AgentID, e.Type, hex.EncodeToString(sum[:])}, "|")
}
