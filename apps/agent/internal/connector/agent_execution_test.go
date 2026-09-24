package connector

import (
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

func directAgentPlan() protocol.TaskPlan {
	args := map[string]any{"command": "version"}
	step := protocol.TaskStep{ID: "s1", Tool: "console.command", Args: args, Risk: "read", Purpose: "execute"}
	digest := operationDigest([]protocol.TaskStep{step})
	return protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", ExecutionMode: "agent_direct",
		PolicyVersion: generatedPolicyVersion, PolicyDigest: generatedPolicyDigest,
		TaskID: "task-direct", InstanceRef: "mcs:daemon:instance", Intent: "novel wording", InventoryRevision: "revision-direct-1",
		AgentExecution: &protocol.AgentToolExecution{
			SchemaVersion: "agent-tool-execution/v1", ToolCallID: "call-direct-1", Tool: "console.command", Arguments: args,
			InstanceRef: "mcs:daemon:instance", InventoryRevision: "revision-direct-1",
			PolicyVersion: generatedPolicyVersion, PolicyDigest: generatedPolicyDigest, OperationDigest: digest,
		},
		Operation: protocol.OperationObjective{
			SchemaVersion: "operation-objective/v2", Digest: digest, Capability: "console.command", Action: "read",
			Target: "version", Parameters: args, Risk: "read",
			ExecutionEvidence:    []protocol.OperationEvidenceRequirement{{Kind: "console", StepID: "s1", Tool: "console.command", Target: "version", Parameters: args}},
			VerificationEvidence: []protocol.OperationEvidenceRequirement{{Kind: "verification", StepID: "terminal", Tool: "terminal", Target: "version", Parameters: map[string]any{}, Order: 1}},
			Recovery:             "retry-read",
		},
		Coverage: "full", Steps: []protocol.TaskStep{step},
	}
}

func TestAgentDirectExecutionAcceptsCanonicalToolCall(t *testing.T) {
	if err := validateOperationPlan(directAgentPlan()); err != nil {
		t.Fatalf("canonical direct execution rejected: %v", err)
	}
}

func TestAgentDirectExecutionAcceptsProducerVerifiedPublicDownload(t *testing.T) {
	args := map[string]any{"url": "https://unlisted.example/releases/grim.jar?build=42", "target": "downloads/grim.jar"}
	step := protocol.TaskStep{ID: "s1", Tool: "file.download", Args: args, Risk: "low", Purpose: "execute"}
	digest := operationDigest([]protocol.TaskStep{step})
	plan := protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", ExecutionMode: "agent_direct",
		PolicyVersion: generatedPolicyVersion, PolicyDigest: generatedPolicyDigest,
		TaskID: "task-download", InstanceRef: "mcs:daemon:instance", Intent: "download a task artifact",
		InventoryRevision: "revision-download-1", Coverage: "full", Steps: []protocol.TaskStep{step},
		AgentExecution: &protocol.AgentToolExecution{
			SchemaVersion: "agent-tool-execution/v1", ToolCallID: "call-download-1", Tool: step.Tool,
			Arguments: args, InstanceRef: "mcs:daemon:instance", InventoryRevision: "revision-download-1",
			PolicyVersion: generatedPolicyVersion, PolicyDigest: generatedPolicyDigest, OperationDigest: digest,
		},
		Operation: protocol.OperationObjective{
			SchemaVersion: "operation-objective/v2", Digest: digest, Capability: step.Tool, Action: "write",
			Target: "downloads/grim.jar", Parameters: args, Risk: "low", RequiresConfirmation: false,
			ExecutionEvidence:    []protocol.OperationEvidenceRequirement{{Kind: "download", StepID: "s1", Tool: step.Tool, Target: "downloads/grim.jar", Parameters: args, Order: 0}},
			VerificationEvidence: []protocol.OperationEvidenceRequirement{{Kind: "verification.download", StepID: "s1", Tool: step.Tool, Target: "downloads/grim.jar", Parameters: args, Order: 0}},
			Recovery:             "diagnose",
		},
	}
	if err := validateOperationPlan(plan); err != nil {
		t.Fatalf("canonical producer-verified download rejected: %v", err)
	}
	invalidStep := step
	invalidStep.Args = map[string]any{"url": args["url"], "target": "plugins/grim.jar"}
	if err := validateRegisteredToolSchema(invalidStep); err == nil {
		t.Fatal("active plugin destination bypassed the install boundary")
	}
}

func TestAgentDirectExecutionRejectsEnvelopeTampering(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*protocol.TaskPlan)
	}{
		{"tool", func(p *protocol.TaskPlan) { p.AgentExecution.Tool = "files.list" }},
		{"arguments", func(p *protocol.TaskPlan) { p.AgentExecution.Arguments = map[string]any{"command": "list"} }},
		{"instance", func(p *protocol.TaskPlan) { p.AgentExecution.InstanceRef = "mcs:other" }},
		{"revision", func(p *protocol.TaskPlan) { p.AgentExecution.InventoryRevision = "revision-other" }},
		{"policy", func(p *protocol.TaskPlan) { p.AgentExecution.PolicyDigest = "tampered" }},
		{"digest", func(p *protocol.TaskPlan) { p.AgentExecution.OperationDigest = "tampered" }},
		{"legacy goal", func(p *protocol.TaskPlan) { p.SourceGoals = []protocol.SourceGoal{{ID: "unexpected"}} }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := directAgentPlan()
			tt.mutate(&plan)
			if err := validateOperationPlan(plan); err == nil {
				t.Fatal("tampered direct execution was accepted")
			}
		})
	}
}
