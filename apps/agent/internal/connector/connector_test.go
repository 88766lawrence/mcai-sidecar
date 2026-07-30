package connector

import (
	"testing"
	"time"
)

func TestNewUsesConfiguredInventoryInterval(t *testing.T) {
	client, err := New("ws://127.0.0.1:4100/agent", "tenant", "agent", nil, nil, nil, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if client.inventoryInterval != 30*time.Second {
		t.Fatalf("inventory interval = %s, want 30s", client.inventoryInterval)
	}
}

func TestNewDefaultsInventoryInterval(t *testing.T) {
	client, err := New("ws://127.0.0.1:4100/agent", "tenant", "agent", nil, nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if client.inventoryInterval != 5*time.Minute {
		t.Fatalf("inventory interval = %s, want 5m", client.inventoryInterval)
	}
}
