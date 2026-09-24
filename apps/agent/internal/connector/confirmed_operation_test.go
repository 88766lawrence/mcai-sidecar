package connector

import (
	"testing"
	"time"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

func confirmedConsolePlan(command string) protocol.TaskPlan {
	step := protocol.TaskStep{ID: "s1", Tool: "console.command", Args: map[string]any{"command": command}, Risk: "medium", Purpose: "execute", RequiresConfirmation: true}
	plan := protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", PolicyVersion: generatedPolicyVersion, PolicyDigest: generatedPolicyDigest,
		TaskID: "task-confirmed", InstanceRef: "mcs:daemon:instance", Intent: "fixture intent", InventoryRevision: "rev-1",
		Operation: protocol.OperationObjective{SchemaVersion: "operation-objective/v2", Capability: "console.command", Action: "write", Target: command, Parameters: step.Args, Risk: "medium", RequiresConfirmation: true, ExecutionEvidence: []protocol.OperationEvidenceRequirement{{Kind: "console", StepID: "s1", Tool: "console.command", Target: command, Parameters: step.Args, Order: 0}}, Recovery: "diagnose"},
		Steps:     []protocol.TaskStep{step}, Coverage: "full",
		ClauseLedger: []protocol.ClauseRoleEntry{{ID: "meta", SourceText: "fixture intent", SourceStart: 0, SourceEnd: 14, Role: "discourse", Polarity: "positive", Status: "mapped", SourceGoalIDs: []string{"bad"}}},
	}
	plan.Operation.Digest = operationDigest(plan.Steps)
	plan.ConfirmedOperation = newConfirmedOperation(plan, time.Now().UTC(), time.Now().UTC().Add(5*time.Minute))
	return plan
}

func TestConfirmedBasicWritesBypassNonSafetySemanticLedgers(t *testing.T) {
	for _, command := range []string{"weather clear", "time set noon", "gamerule doMobSpawning false", "whitelist add BirchPilot"} {
		plan := confirmedConsolePlan(command)
		if err := validateOperationPlan(plan); err != nil {
			t.Fatalf("confirmed %q was blocked after approval: %v", command, err)
		}
	}
}

func TestConfirmedOperationDigestMatchesTypeScriptVector(t *testing.T) {
	plan := confirmedConsolePlan("weather clear")
	if got, want := plan.Operation.Digest, "df873e7e4b572205386dd23f6a987a328bb17b0bf6d2f5620b5b66824ab268df"; got != want {
		t.Fatalf("operation digest drifted: got %s want %s", got, want)
	}
	if got, want := plan.ConfirmedOperation.SummaryDigest, "715c55f781e3f9d5f683ff80675a0c190555499d2ca7bfa2cd29501398e83e13"; got != want {
		t.Fatalf("confirmed-operation digest drifted: got %s want %s", got, want)
	}
}

func TestConfirmedOperationRejectsPostApprovalTampering(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*protocol.TaskPlan)
	}{
		{"command changed", func(p *protocol.TaskPlan) {
			p.Steps[0].Args["command"] = "weather thunder"
			p.Operation.Parameters = p.Steps[0].Args
			p.Operation.Target = "weather thunder"
			p.Operation.Digest = operationDigest(p.Steps)
		}},
		{"instance changed", func(p *protocol.TaskPlan) { p.InstanceRef = "mcs:other:instance" }},
		{"second write added", func(p *protocol.TaskPlan) {
			p.Steps = append(p.Steps, protocol.TaskStep{ID: "s2", Tool: "console.command", Args: map[string]any{"command": "say injected"}, Risk: "medium", RequiresConfirmation: true})
			p.Operation.Digest = operationDigest(p.Steps)
		}},
		{"risk downgraded", func(p *protocol.TaskPlan) { p.Steps[0].Risk = "read"; p.Operation.Risk = "read" }},
		{"confirmation missing", func(p *protocol.TaskPlan) { p.ConfirmedOperation = nil }},
		{"summary mismatched", func(p *protocol.TaskPlan) { p.ConfirmedOperation.SummaryDigest = "00" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan := confirmedConsolePlan("weather clear")
			test.mutate(&plan)
			if err := validateOperationPlan(plan); err == nil {
				t.Fatal("post-confirmation tampering was accepted")
			}
		})
	}
}

func TestConfirmedOperationStillEnforcesBasicToolSchema(t *testing.T) {
	for _, args := range []map[string]any{{"command": ""}, {"command": "weather clear", "shell": true}} {
		plan := confirmedConsolePlan("weather clear")
		plan.Steps[0].Args = args
		plan.Operation.Parameters = args
		plan.Operation.Target = stepTarget(plan.Steps[0])
		plan.Operation.Digest = operationDigest(plan.Steps)
		plan.ConfirmedOperation = newConfirmedOperation(plan, time.Now().UTC(), time.Now().UTC().Add(5*time.Minute))
		if err := validateOperationPlan(plan); err == nil {
			t.Fatalf("invalid console schema was accepted: %#v", args)
		}
	}
}
