package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"

	"github.com/mcai/sidecar-agent/internal/identity"
)

func TestEnvelopePayloadMatchesJavaScriptJSONForLogCharacters(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := &identity.Identity{AgentID: "agent-test", PublicKey: publicKey, PrivateKey: privateKey}

	envelope, err := NewEnvelope(id, "tenant", "message", "nonce", "task.event", map[string]any{
		"kind":    "logs",
		"summary": "<Server thread/INFO> A&B > C",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"kind":"logs","summary":"<Server thread/INFO> A&B > C"}`
	if string(envelope.Payload) != want {
		t.Fatalf("payload = %q, want JavaScript-compatible %q", envelope.Payload, want)
	}
	if !ed25519.Verify(publicKey, []byte(envelope.Canonical()), mustDecodeSignature(t, envelope.Signature)) {
		t.Fatal("envelope signature did not verify")
	}
}

func mustDecodeSignature(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil || len(decoded) != ed25519.SignatureSize {
		t.Fatalf("decode signature: len=%d err=%v", len(decoded), err)
	}
	return decoded
}
