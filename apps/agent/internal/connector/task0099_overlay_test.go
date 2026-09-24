package connector

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

func TestTask0099GeneratedPlanOverlay(t *testing.T) {
	path := os.Getenv("MCAI_TASK0099_PLAN")
	if path == "" {
		t.Skip("MCAI_TASK0099_PLAN is not set")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var plan protocol.TaskPlan
	if err := json.Unmarshal(raw, &plan); err != nil {
		t.Fatal(err)
	}
	if err := validateOperationPlan(plan); err != nil {
		t.Fatalf("generated Cloud plan rejected by Go zero-trust validator: %v", err)
	}
}
