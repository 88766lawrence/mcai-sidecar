package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Identity struct {
	AgentID    string
	PublicKey  ed25519.PublicKey
	PrivateKey ed25519.PrivateKey
	PairingCode string
}

func LoadOrCreate(dataDir string) (*Identity, error) {
	path := filepath.Join(dataDir, "device.key")
	b, err := os.ReadFile(path)
	var private ed25519.PrivateKey
	if err == nil {
		decoded, decodeErr := base64.RawStdEncoding.DecodeString(strings.TrimSpace(string(b)))
		if decodeErr != nil || len(decoded) != ed25519.PrivateKeySize { return nil, fmt.Errorf("invalid device key") }
		private = ed25519.PrivateKey(decoded)
	} else if os.IsNotExist(err) {
		_, generated, generateErr := ed25519.GenerateKey(rand.Reader)
		if generateErr != nil { return nil, generateErr }
		private = generated
		if writeErr := os.WriteFile(path, []byte(base64.RawStdEncoding.EncodeToString(private)), 0o600); writeErr != nil { return nil, writeErr }
	} else { return nil, err }
	public := private.Public().(ed25519.PublicKey)
	sum := sha256.Sum256(public)
	codeBytes := make([]byte, 5)
	if _, err := rand.Read(codeBytes); err != nil { return nil, err }
	code := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(codeBytes)
	return &Identity{AgentID: "agent_" + hex.EncodeToString(sum[:8]), PublicKey: public, PrivateKey: private, PairingCode: code}, nil
}

func (i *Identity) PublicKeyString() string { return base64.RawStdEncoding.EncodeToString(i.PublicKey) }
func (i *Identity) Sign(message []byte) string { return base64.RawStdEncoding.EncodeToString(ed25519.Sign(i.PrivateKey, message)) }

