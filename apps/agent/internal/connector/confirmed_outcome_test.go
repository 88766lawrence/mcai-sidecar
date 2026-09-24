package connector

import (
	"reflect"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

func TestConfirmedTaskEventPayloadBindsExactApprovedStep(t *testing.T) {
	plan := protocol.TaskPlan{
		TaskID: "task-generic",
		ConfirmedOperation: &protocol.ConfirmedOperation{
			OperationDigest: "operation-digest",
			SummaryDigest:   "confirmation-digest",
			Steps: []protocol.ConfirmedOperationStep{{
				ID: "step-1", Tool: "instance.stop", Target: "mcs:node:world",
				Parameters: map[string]any{"target": "mcs:node:world", "timeout_seconds": float64(120)},
				Purpose:    "execute",
			}},
		},
	}
	payload := confirmedTaskEventPayload(plan, "SUCCEEDED", "execution", "accepted")
	for key, expected := range map[string]any{
		"task_id": "task-generic", "state": "SUCCEEDED", "kind": "execution", "summary": "accepted",
		"step_id": "step-1", "tool": "instance.stop", "target": "mcs:node:world",
		"operation_digest": "operation-digest", "confirmation_digest": "confirmation-digest",
	} {
		if !reflect.DeepEqual(payload[key], expected) {
			t.Fatalf("%s mismatch: got %#v want %#v", key, payload[key], expected)
		}
	}
	if !reflect.DeepEqual(payload["parameters"], plan.ConfirmedOperation.Steps[0].Parameters) {
		t.Fatalf("parameters were not projected exactly: %#v", payload["parameters"])
	}
}

func TestConfirmedTaskEventPayloadDoesNotGuessAcrossMultipleExecuteSteps(t *testing.T) {
	plan := protocol.TaskPlan{TaskID: "task-multi", ConfirmedOperation: &protocol.ConfirmedOperation{
		OperationDigest: "digest", SummaryDigest: "confirmation",
		Steps: []protocol.ConfirmedOperationStep{
			{ID: "a", Tool: "console.command", Purpose: "execute"},
			{ID: "b", Tool: "console.command", Purpose: "execute"},
		},
	}}
	payload := confirmedTaskEventPayload(plan, "FAILED", "tool", "rejected")
	if _, ok := payload["step_id"]; ok {
		t.Fatal("ambiguous multi-write event must not receive a guessed step binding")
	}
}
