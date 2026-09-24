package connector

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/mcai/sidecar-agent/internal/executor"
	"github.com/mcai/sidecar-agent/internal/logquery"
	"github.com/mcai/sidecar-agent/internal/protocol"
)

func TestConfirmedConsoleEventCarriesAuditableOutcome(t *testing.T) {
	plan := protocol.TaskPlan{TaskID: "task-outcome", ConfirmedOperation: &protocol.ConfirmedOperation{
		SchemaVersion: "confirmed-operation/v1", OperationDigest: "op-digest", SummaryDigest: "confirmation-digest",
		Steps: []protocol.ConfirmedOperationStep{{ID: "s1", Tool: "console.command", Target: "title @a actionbar payload", Parameters: map[string]any{"command": "title @a actionbar payload"}, Purpose: "execute"}},
	}}
	payload := confirmedTaskEventPayload(plan, "", "console", "控制台返回：\nNo targets were found")
	outcome, ok := payload["command_outcome"].(executor.ConsoleCommandOutcome)
	if !ok || outcome.SchemaVersion != "console-command-outcome/v1" || outcome.Status != "rejected" || outcome.Code != "NO_TARGETS" || outcome.OutputSHA256 == "" {
		t.Fatalf("unexpected command outcome payload: %#v", payload["command_outcome"])
	}
}

func TestConfirmedConsoleEventFailsClosedForTruncatedWriteCallback(t *testing.T) {
	plan := protocol.TaskPlan{TaskID: "task-fragment", ConfirmedOperation: &protocol.ConfirmedOperation{
		SchemaVersion: "confirmed-operation/v1", OperationDigest: "op-digest", SummaryDigest: "confirmation-digest",
		Steps: []protocol.ConfirmedOperationStep{{ID: "s1", Tool: "console.command", Target: `tellraw @a {"text":"Doors open soon"}`, Parameters: map[string]any{"command": `tellraw @a {"text":"Doors open soon"}`}, Purpose: "execute", Risk: "high", RequiresConfirmation: true}},
	}}
	payload := confirmedTaskEventPayload(plan, "", "console", "控制台返回：\nt")
	outcome, ok := payload["command_outcome"].(executor.ConsoleCommandOutcome)
	if !ok || outcome.Status != "indeterminate" || outcome.Code != "INCOMPLETE_CALLBACK" {
		t.Fatalf("truncated confirmed callback was trusted: %#v", payload)
	}
}

func TestPluginResolveEventCarriesTypedArtifactObservation(t *testing.T) {
	summary := "Plugin resolve result: project=luckperms; version=v5.5.71-bukkit; source=modrinth; artifact=LuckPerms-Bukkit-5.5.71.jar; compatibility=exact-game-version; sha256=; source_sha512=188a91f0a543d23bfda32385fca6db63d61e49c8a422bd452a260bd9cbc6a7d7fe45071199e9fca8f3ce43c2b41ee84fd315bd15464577028ff3951a7d4fab27"
	payload := confirmedTaskEventPayload(protocol.TaskPlan{TaskID: "resolve-task"}, "", "plugin", summary)
	observed, ok := payload["observed"].(map[string]any)
	if !ok || observed["schema_version"] != "resolved-plugin/v1" || observed["project"] != "luckperms" || observed["artifact"] != "LuckPerms-Bukkit-5.5.71.jar" {
		t.Fatalf("missing typed plugin observation: %#v", payload)
	}
}

func TestPluginResolveEventRejectsMalformedIntegrity(t *testing.T) {
	summary := "Plugin resolve result: project=luckperms; version=v1; source=modrinth; artifact=x.jar; compatibility=exact; sha256=; source_sha512=bad"
	payload := confirmedTaskEventPayload(protocol.TaskPlan{TaskID: "resolve-task"}, "", "plugin", summary)
	if _, ok := payload["observed"]; ok {
		t.Fatalf("malformed integrity became authority: %#v", payload)
	}
}

func TestConfirmedGuardedAudienceFailureProjectsNoTargets(t *testing.T) {
	command := "execute if entity @a run execute as @a at @s run particle minecraft:happy_villager ~ ~1 ~ 0.25 0.25 0.25 0 5 force @s"
	plan := protocol.TaskPlan{TaskID: "task-audience", ConfirmedOperation: &protocol.ConfirmedOperation{
		SchemaVersion: "confirmed-operation/v1", OperationDigest: "op-digest", SummaryDigest: "confirmation-digest",
		Steps: []protocol.ConfirmedOperationStep{{ID: "s1", Tool: "console.command", Target: command, Parameters: map[string]any{"command": command}, Purpose: "execute", Risk: "medium", RequiresConfirmation: true}},
	}}
	payload := confirmedTaskEventPayload(plan, "", "console", "控制台返回：\nTest failed")
	outcome, ok := payload["command_outcome"].(executor.ConsoleCommandOutcome)
	if !ok || outcome.Status != "rejected" || outcome.Code != "NO_TARGETS" {
		t.Fatalf("guarded audience outcome was not projected: %#v", payload)
	}
}

func TestValidationRejectionIsStableRedactedAndIdempotent(t *testing.T) {
	connector := &Connector{rejectedTasks: map[string]bool{}}
	events := []map[string]any{}
	connector.sendMessage = func(messageType string, payload any) error {
		if messageType != "task.event" {
			t.Fatalf("unexpected message type %s", messageType)
		}
		events = append(events, payload.(map[string]any))
		return nil
	}
	plan := protocol.TaskPlan{SchemaVersion: "task-plan/v1", TaskID: "task-redwood", InstanceRef: "mcs:test"}
	for range 2 {
		if err := connector.rejectTask(context.Background(), plan, errors.New("verification step s9 has no preceding compatible execute step")); err != nil {
			t.Fatal(err)
		}
	}
	if len(events) != 1 {
		t.Fatalf("rejection events = %d, want exactly one", len(events))
	}
	if events[0]["state"] != "REJECTED" || events[0]["code"] != "PLAN_VALIDATION_REJECTED" || events[0]["stage"] != "validation" {
		t.Fatalf("unexpected rejection payload: %#v", events[0])
	}
	if events[0]["provider_calls"] != 0 || events[0]["tool_calls"] != 0 {
		t.Fatalf("rejection claimed calls: %#v", events[0])
	}
}

func TestHandleInvalidTaskExecuteReturnsOneRejectionWithoutStartingExecutor(t *testing.T) {
	connector := &Connector{rejectedTasks: map[string]bool{}}
	events := 0
	connector.sendMessage = func(messageType string, payload any) error {
		events++
		if messageType != "task.event" || payload.(map[string]any)["state"] != "REJECTED" {
			t.Fatalf("unexpected rejection event: %s %#v", messageType, payload)
		}
		return nil
	}
	plan := protocol.TaskPlan{SchemaVersion: "task-plan/v1", TaskID: "task-saffron", InstanceRef: "mcs:test"}
	payload, _ := json.Marshal(plan)
	raw, _ := json.Marshal(map[string]any{"type": "task.execute", "tenant_id": "tenant", "payload": json.RawMessage(payload)})
	for range 2 {
		if err := connector.handle(context.Background(), raw); err != nil {
			t.Fatal(err)
		}
	}
	if events != 1 {
		t.Fatalf("rejection events = %d, want 1", events)
	}
}

func TestNewUsesConfiguredInventoryInterval(t *testing.T) {
	client, err := New("ws://127.0.0.1:4100/agent", "tenant", "agent", nil, nil, nil, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if client.inventoryInterval != 30*time.Second {
		t.Fatalf("inventory interval = %s, want 30s", client.inventoryInterval)
	}
}

func TestValidateOperationPlanRequiresIndependentReadOnlyVerificationForWrites(t *testing.T) {
	plan := protocol.TaskPlan{
		Operation: protocol.OperationObjective{
			SchemaVersion: "operation-objective/v1", Capability: "console.command", Action: "write",
			Target: "gamerule keepInventory true", Risk: "medium", RequiresConfirmation: true,
			ExecutionEvidence:    []protocol.OperationEvidenceRequirement{{Kind: "console"}},
			VerificationEvidence: []protocol.OperationEvidenceRequirement{{Kind: "verification.console"}},
		},
		Steps: []protocol.TaskStep{
			{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "gamerule keepInventory true"}, Risk: "medium", RequiresConfirmation: true},
			{ID: "s2", Tool: "console.command", Args: map[string]any{"command": "gamerule keepInventory"}, Risk: "read", Purpose: "verify"},
		},
	}
	if err := validateOperationPlan(plan); err != nil {
		t.Fatalf("valid execute-and-verify plan rejected: %v", err)
	}

	plan.Steps = plan.Steps[:1]
	if err := validateOperationPlan(plan); err == nil {
		t.Fatal("write plan without verification was accepted")
	}
}

func TestValidateOperationPlanRejectsRiskDriftAndWritableVerification(t *testing.T) {
	plan := protocol.TaskPlan{
		Operation: protocol.OperationObjective{
			SchemaVersion: "operation-objective/v1", Capability: "config.patch", Action: "write",
			Target: "plugins/Example/config.yml", Risk: "read",
			ExecutionEvidence:    []protocol.OperationEvidenceRequirement{{Kind: "config"}},
			VerificationEvidence: []protocol.OperationEvidenceRequirement{{Kind: "verification.config"}},
		},
		Steps: []protocol.TaskStep{{ID: "s1", Tool: "config.patch", Risk: "medium", RequiresConfirmation: true}},
	}
	if err := validateOperationPlan(plan); err == nil {
		t.Fatal("operation objective risk drift was accepted")
	}

	plan.Operation.Risk = "medium"
	plan.Operation.RequiresConfirmation = true
	plan.Steps = append(plan.Steps, protocol.TaskStep{
		ID: "s2", Tool: "config.patch", Risk: "medium", Purpose: "verify", RequiresConfirmation: true,
	})
	if err := validateOperationPlan(plan); err == nil {
		t.Fatal("writable verification step was accepted")
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

func TestOperationPolicyRejectsNewPlanTamperingVariants(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*protocol.TaskPlan)
	}{
		{"low declared risk for config write", func(p *protocol.TaskPlan) { p.Steps[0].Risk = "low"; p.Operation.Risk = "low" }},
		{"read action for plugin install", func(p *protocol.TaskPlan) { p.Steps[0].Tool = "plugin.install"; p.Operation.Action = "read" }},
		{"diagnose action for lifecycle", func(p *protocol.TaskPlan) {
			p.Steps[0].Tool = "instance.restart"
			p.Steps[0].Risk = "high"
			p.Operation.Action = "diagnose"
			p.Operation.Risk = "high"
		}},
		{"medium write without step confirmation", func(p *protocol.TaskPlan) {
			p.Steps[0].RequiresConfirmation = false
			p.Operation.RequiresConfirmation = false
		}},
		{"write placed in verify role", func(p *protocol.TaskPlan) { p.Steps[1].Tool = "plugin.install" }},
		{"verification evidence missing prefix", func(p *protocol.TaskPlan) { p.Operation.VerificationEvidence[0].Kind = "config" }},
		{"execution evidence has verification prefix", func(p *protocol.TaskPlan) { p.Operation.ExecutionEvidence[0].Kind = "verification.config" }},
		{"verification tool does not match evidence", func(p *protocol.TaskPlan) { p.Steps[1].Tool = "files.list" }},
		{"verification reads a different target", func(p *protocol.TaskPlan) {
			p.Steps[0].Args = map[string]any{"path": "server.properties"}
			p.Steps[1].Args = map[string]any{"path": "plugins/Other/config.yml"}
		}},
		{"verification precedes mutation", func(p *protocol.TaskPlan) { p.Steps[0], p.Steps[1] = p.Steps[1], p.Steps[0] }},
		{"operation capability disguises primary tool", func(p *protocol.TaskPlan) { p.Operation.Capability = "logs.query" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := validOperationPolicyPlan()
			tt.mutate(&plan)
			if err := validateOperationPlan(plan); err == nil {
				t.Fatal("tampered operation plan was accepted")
			}
		})
	}
}

func validOperationPolicyPlan() protocol.TaskPlan {
	return protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", TaskID: "policy-plan", InstanceRef: "mcs:test",
		Operation: protocol.OperationObjective{
			SchemaVersion: "operation-objective/v1", Capability: "config.patch", Action: "write", Target: "server.properties",
			Risk: "medium", RequiresConfirmation: true,
			ExecutionEvidence:    []protocol.OperationEvidenceRequirement{{Kind: "config"}},
			VerificationEvidence: []protocol.OperationEvidenceRequirement{{Kind: "verification.config"}},
		},
		Steps: []protocol.TaskStep{
			{ID: "s1", Tool: "config.patch", Args: map[string]any{"path": "server.properties"}, Risk: "medium", RequiresConfirmation: true, Purpose: "execute"},
			{ID: "s2", Tool: "config.inspect", Args: map[string]any{"path": "server.properties"}, Risk: "read", Purpose: "verify"},
		},
	}
}

func TestOperationPolicyAcceptsResolveOnlyReadCapability(t *testing.T) {
	plan := protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", TaskID: "resolve-only", InstanceRef: "mcs:test",
		Operation: protocol.OperationObjective{
			SchemaVersion: "operation-objective/v1", Capability: "plugin.resolve", Action: "read", Target: "dynmap",
			Risk: "read", ExecutionEvidence: []protocol.OperationEvidenceRequirement{{Kind: "plugin"}},
			VerificationEvidence: []protocol.OperationEvidenceRequirement{{Kind: "verification"}},
		},
		Steps: []protocol.TaskStep{{ID: "s1", Tool: "plugin.resolve", Risk: "read"}},
	}
	if err := validateOperationPlan(plan); err != nil {
		t.Fatalf("resolve-only read plan rejected: %v", err)
	}
}

func TestOperationPolicyAcceptsOrderedCompoundConsolePairs(t *testing.T) {
	plan := protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", TaskID: "compound-console", InstanceRef: "mcs:test",
		Operation: protocol.OperationObjective{
			SchemaVersion: "operation-objective/v1", Capability: "console.command", Action: "write", Target: "time set day",
			Risk: "medium", RequiresConfirmation: true,
			ExecutionEvidence:    []protocol.OperationEvidenceRequirement{{Kind: "console"}},
			VerificationEvidence: []protocol.OperationEvidenceRequirement{{Kind: "verification.console"}, {Kind: "verification.logs"}},
		},
		Steps: []protocol.TaskStep{
			{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "time set day"}, Risk: "medium", RequiresConfirmation: true},
			{ID: "s2", Tool: "console.command", Args: map[string]any{"command": "time query daytime"}, Risk: "read", Purpose: "verify"},
			{ID: "s3", Tool: "console.command", Args: map[string]any{"command": "weather rain"}, Risk: "medium", RequiresConfirmation: true},
			{ID: "s4", Tool: "logs.query", Risk: "read", Purpose: "verify"},
		},
	}
	if err := validateOperationPlan(plan); err != nil {
		t.Fatalf("ordered compound console plan rejected: %v", err)
	}
}

func TestBoundOperationRejectsFreshFieldTampering(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*protocol.TaskPlan)
	}{
		{"approval target changed", func(p *protocol.TaskPlan) { p.Operation.Target = "op SilverHeron" }},
		{"approval parameters changed", func(p *protocol.TaskPlan) { p.Operation.Parameters["command"] = "deop QuartzOtter" }},
		{"execute command changed", func(p *protocol.TaskPlan) { p.Steps[0].Args["command"] = "op AmberFalcon" }},
		{"execute evidence step changed", func(p *protocol.TaskPlan) { p.Operation.ExecutionEvidence[0].StepID = "s9" }},
		{"execute evidence tool changed", func(p *protocol.TaskPlan) { p.Operation.ExecutionEvidence[0].Tool = "logs.query" }},
		{"execute evidence target changed", func(p *protocol.TaskPlan) { p.Operation.ExecutionEvidence[0].Target = "op SilverHeron" }},
		{"execute evidence parameters changed", func(p *protocol.TaskPlan) { p.Operation.ExecutionEvidence[0].Parameters["command"] = "op AmberFalcon" }},
		{"verification evidence order changed", func(p *protocol.TaskPlan) { p.Operation.VerificationEvidence[0].Order = 8 }},
		{"verification evidence step changed", func(p *protocol.TaskPlan) { p.Operation.VerificationEvidence[0].StepID = "s8" }},
		{"verification evidence target changed", func(p *protocol.TaskPlan) { p.Operation.VerificationEvidence[0].Target = "op SilverHeron" }},
		{"unrelated contains token", func(p *protocol.TaskPlan) { p.Operation.ExecutionEvidence[0].Contains = []string{"SilverHeron"} }},
		{"operation digest changed", func(p *protocol.TaskPlan) { p.Operation.Digest = "00" + p.Operation.Digest[2:] }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := freshBoundOperationPlan()
			tt.mutate(&plan)
			if err := validateOperationPlan(plan); err == nil {
				t.Fatal("field-tampered bound plan was accepted")
			}
		})
	}
}

func TestBoundOperationAcceptsCanonicalPlan(t *testing.T) {
	plan := freshBoundOperationPlan()
	plan.ConfirmedOperation = newConfirmedOperation(plan, time.Now().UTC(), time.Now().UTC().Add(5*time.Minute))
	if err := validateOperationPlan(plan); err != nil {
		t.Fatalf("canonical bound operation rejected: %v", err)
	}
}

func TestClauseRoleLedgerRejectsFreshTraceTampering(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*protocol.TaskPlan)
	}{
		{"clause source shifted", func(p *protocol.TaskPlan) {
			p.ClauseLedger[0].SourceStart = 1
			p.ClauseLedgerDigest = clauseLedgerDigest(p.Intent, p.ClauseLedger)
		}},
		{"domain role changed", func(p *protocol.TaskPlan) {
			p.ClauseLedger[0].Role = "response_requirement"
			p.ClauseLedgerDigest = clauseLedgerDigest(p.Intent, p.ClauseLedger)
		}},
		{"atom clause removed", func(p *protocol.TaskPlan) {
			p.SourceAtoms[0].ClauseID = ""
			p.SourceAtomDigest = sourceAtomDigest(p.Intent, p.SourceAtoms)
			p.SourceGoalDigest = sourceGoalLedgerDigest(p.Intent, p.SourceAtoms, p.SourceGoals)
		}},
		{"atom reverse mapping removed", func(p *protocol.TaskPlan) {
			p.ClauseLedger[0].SourceAtomIDs = nil
			p.ClauseLedgerDigest = clauseLedgerDigest(p.Intent, p.ClauseLedger)
		}},
		{"goal reverse mapping removed", func(p *protocol.TaskPlan) {
			p.ClauseLedger[0].SourceGoalIDs = nil
			p.ClauseLedgerDigest = clauseLedgerDigest(p.Intent, p.ClauseLedger)
		}},
		{"evidence policy role forged", func(p *protocol.TaskPlan) { p.EvidencePolicy.ClauseIDs = []string{"clause-1"} }},
		{"response policy role forged", func(p *protocol.TaskPlan) { p.ResponsePolicy.ClauseIDs = []string{"clause-1"} }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := freshBoundOperationPlan()
			tt.mutate(&plan)
			if err := validateOperationPlan(plan); err == nil {
				t.Fatal("clause-role trace tampering was accepted")
			}
		})
	}
}

func TestSourceGoalDigestMatchesCloudCanonicalEncoding(t *testing.T) {
	var fixture struct {
		Intent      string                `json:"intent"`
		SourceGoals []protocol.SourceGoal `json:"source_goals"`
		Digest      string                `json:"source_goal_digest"`
	}
	raw := `{"intent":"读取服务端版本、在线成员和 TPS，然后给出容量建议","source_goals":[{"id":"sg-1-server-version","source_text":"服务端版本","source_start":2,"source_end":7,"normalized":"server.version","domain":"server","entity":"version","result_kind":"fact","depends_on":[],"required":true,"status":"mapped"},{"id":"sg-2-players-online","source_text":"在线成员","source_start":8,"source_end":12,"normalized":"players.online","domain":"players","entity":"online","result_kind":"collection","depends_on":[],"required":true,"status":"mapped"},{"id":"sg-3-performance-tps","source_text":"TPS","source_start":14,"source_end":17,"normalized":"performance.tps","domain":"performance","entity":"tps","result_kind":"fact","depends_on":[],"required":true,"status":"mapped"},{"id":"sg-4-derived-judgement","source_text":"然后给出容量建议","source_start":18,"source_end":26,"normalized":"derived.judgement","domain":"derived","entity":"judgement","result_kind":"judgement","depends_on":["sg-1-server-version","sg-2-players-online","sg-3-performance-tps"],"required":true,"status":"mapped"}],"source_goal_digest":"a9491adc563057a6e9cc3de2ea279fdc1f7b0fbb4698a2133b39adafb3ce8b8f"}`
	if err := json.Unmarshal([]byte(raw), &fixture); err != nil {
		t.Fatal(err)
	}
	want := "2ee367000b88389c3145a7d65f2fdecb8691195e5088268587bfe0eb65721b03"
	if got := sourceGoalDigest(fixture.Intent, fixture.SourceGoals); got != want {
		t.Fatalf("Cloud/Agent source goal digest drift: got %s want %s", got, want)
	}
}

func freshBoundOperationPlan() protocol.TaskPlan {
	logQuery := logquery.New([]logquery.Group{{AllOf: []string{"all"}, AnyOf: []string{}}})
	plan := protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", PolicyVersion: generatedPolicyVersion, PolicyDigest: generatedPolicyDigest, TaskID: "bound-operation", InstanceRef: "mcs:test", Intent: "grant QuartzOtter operator access",
		Operation: protocol.OperationObjective{
			SchemaVersion: "operation-objective/v2", Capability: "console.command", Action: "write", Target: "op QuartzOtter",
			Parameters: map[string]any{"command": "op QuartzOtter"}, Risk: "high", RequiresConfirmation: true,
			ExecutionEvidence:    []protocol.OperationEvidenceRequirement{{Kind: "console", StepID: "s1", Tool: "console.command", Target: "op QuartzOtter", Parameters: map[string]any{"command": "op QuartzOtter"}, Order: 0, Contains: []string{"QuartzOtter"}}},
			VerificationEvidence: []protocol.OperationEvidenceRequirement{{Kind: "verification.logs", StepID: "s2", Tool: "logs.query", Target: "op QuartzOtter", Parameters: map[string]any{"window_minutes": float64(5), "filter_query": logQuery}, Order: 1, Contains: []string{"op", "QuartzOtter"}}},
		},
		Steps: []protocol.TaskStep{
			{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "op QuartzOtter"}, Risk: "high", RequiresConfirmation: true},
			{ID: "s2", Tool: "logs.query", Args: map[string]any{"window_minutes": float64(5), "filter_query": logQuery}, Risk: "read", Purpose: "verify"},
		},
		Coverage: "full",
	}
	plan.Operation.Digest = operationDigest(plan.Steps)
	plan.SourceGoals = []protocol.SourceGoal{{
		ID: "sg-console-op", SourceText: "grant QuartzOtter operator access", SourceStart: 0, SourceEnd: 33,
		Normalized: "grant operator access", Domain: "console", Entity: "op QuartzOtter", ResultKind: "fact", Required: true, Status: "mapped",
	}}
	plan.ClauseLedger = []protocol.ClauseRoleEntry{{ID: "clause-1", SourceText: plan.Intent, SourceStart: 0, SourceEnd: len([]rune(plan.Intent)), Role: "domain_goal", Polarity: "positive", Status: "mapped", Reason: "eligible_for_source_goal_mapping", SourceAtomIDs: []string{"atom-sg-console-op"}, SourceGoalIDs: []string{"sg-console-op"}, ConstraintActions: []string{}}}
	plan.ClauseLedgerDigest = clauseLedgerDigest(plan.Intent, plan.ClauseLedger)
	plan.EvidencePolicy = protocol.EvidencePolicy{ClauseIDs: []string{}}
	plan.ResponsePolicy = protocol.ResponsePolicy{ClauseIDs: []string{}}
	plan.SourceAtoms = []protocol.SourceAtom{{ID: "atom-sg-console-op", SourceText: plan.Intent, SourceStart: 0, SourceEnd: len([]rune(plan.Intent)), Polarity: "positive", Role: "fact", Normalized: "grant operator access", Required: true, Status: "mapped", SourceGoalIDs: []string{"sg-console-op"}, Reason: "mapped_to_typed_source_goal", ClauseID: "clause-1"}}
	plan.SourceAtomDigest = sourceAtomDigest(plan.Intent, plan.SourceAtoms)
	plan.SourceGoalDigest = sourceGoalLedgerDigest(plan.Intent, plan.SourceAtoms, plan.SourceGoals)
	plan.GoalRequirements = []protocol.GoalRequirement{{
		ID: "g-console-op", Description: "apply console operation", Domain: "console", Action: "write", Target: "op QuartzOtter", Required: true,
		SourceGoalIDs: []string{"sg-console-op"}, ResultKind: "fact",
		ExecuteStepIDs: []string{"s1"}, VerifyStepIDs: []string{"s2"},
		Evidence: append(append([]protocol.OperationEvidenceRequirement{}, plan.Operation.ExecutionEvidence...), plan.Operation.VerificationEvidence...),
	}}
	return plan
}

func TestV2PolicyRejectsSourceGoalCoverageTampering(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*protocol.TaskPlan)
	}{
		{"missing source goals", func(p *protocol.TaskPlan) { p.SourceGoals = nil }},
		{"missing source digest", func(p *protocol.TaskPlan) { p.SourceGoalDigest = "" }},
		{"source digest drift", func(p *protocol.TaskPlan) { p.SourceGoalDigest = "deadbeef" }},
		{"source text does not match intent", func(p *protocol.TaskPlan) { p.SourceGoals[0].SourceText = "different target" }},
		{"source span does not match intent", func(p *protocol.TaskPlan) { p.SourceGoals[0].SourceStart = 6 }},
		{"required source goal unmapped", func(p *protocol.TaskPlan) { p.GoalRequirements[0].SourceGoalIDs = nil }},
		{"goal references unknown source", func(p *protocol.TaskPlan) { p.GoalRequirements[0].SourceGoalIDs = []string{"sg-missing"} }},
		{"derived dependency absent", func(p *protocol.TaskPlan) {
			p.SourceGoals[0].ResultKind = "judgement"
			p.SourceGoals[0].DependsOn = []string{"sg-missing"}
			p.SourceGoalDigest = sourceGoalDigest(p.Intent, p.SourceGoals)
		}},
		{"result shape drift", func(p *protocol.TaskPlan) { p.GoalRequirements[0].ResultKind = "count" }},
		{"unknown source mapping status", func(p *protocol.TaskPlan) {
			p.SourceGoals[0].Status = "trusted"
			p.SourceGoalDigest = sourceGoalDigest(p.Intent, p.SourceGoals)
		}},
		{"filtered count without filter", func(p *protocol.TaskPlan) {
			p.SourceGoals[0].ResultKind = "filtered_count"
			p.GoalRequirements[0].ResultKind = "filtered_count"
			p.SourceGoalDigest = sourceGoalDigest(p.Intent, p.SourceGoals)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := freshBoundOperationPlan()
			tt.mutate(&plan)
			if err := validateOperationPlan(plan); err == nil {
				t.Fatal("source-goal tampering was accepted")
			}
		})
	}
}

func TestV2PolicyRejectsGoalConstraintAndIntrinsicRiskTampering(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*protocol.TaskPlan)
	}{
		{"partial coverage", func(p *protocol.TaskPlan) { p.Coverage = "partial" }},
		{"waiting coverage", func(p *protocol.TaskPlan) { p.Coverage = "waiting" }},
		{"missing goals", func(p *protocol.TaskPlan) { p.GoalRequirements = nil }},
		{"unsupported required goal", func(p *protocol.TaskPlan) { p.GoalRequirements[0].Status = "unsupported" }},
		{"goal missing execute binding", func(p *protocol.TaskPlan) { p.GoalRequirements[0].ExecuteStepIDs = nil }},
		{"goal bound to verify as execute", func(p *protocol.TaskPlan) { p.GoalRequirements[0].ExecuteStepIDs = []string{"s2"} }},
		{"goal bound to execute as verify", func(p *protocol.TaskPlan) { p.GoalRequirements[0].VerifyStepIDs = []string{"s1"} }},
		{"goal evidence borrowed from another step", func(p *protocol.TaskPlan) { p.GoalRequirements[0].Evidence[0].StepID = "s9" }},
		{"forbidden write", func(p *protocol.TaskPlan) {
			p.Constraints = []protocol.PlanConstraint{{Action: "write", Effect: "forbid", Source: "read-only"}}
		}},
		{"forbidden restart component", func(p *protocol.TaskPlan) {
			p.Steps[0].Tool = "instance.restart"
			p.Steps[0].Args = map[string]any{}
			p.Steps[0].Risk = "high"
			p.Operation.Capability = "instance.restart"
			p.Operation.Action = "lifecycle"
			p.Operation.Target = "instance.restart"
			p.Operation.Parameters = map[string]any{}
			p.Operation.Risk = "high"
			p.Operation.Digest = operationDigest(p.Steps)
			p.Constraints = []protocol.PlanConstraint{{Action: "restart", Effect: "forbid", Source: "never restart"}}
		}},
		{"unknown constraint effect", func(p *protocol.TaskPlan) {
			p.Constraints = []protocol.PlanConstraint{{Action: "write", Effect: "allow", Source: "tampered"}}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := freshBoundOperationPlan()
			tt.mutate(&plan)
			if err := validateOperationPlan(plan); err == nil {
				t.Fatal("tampered v2 plan was accepted")
			}
		})
	}
}

func TestServerInstallCannotDeclareLowRiskOrSkipConfirmation(t *testing.T) {
	plan := protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", TaskID: "install-policy", InstanceRef: "mcs:test", Coverage: "full",
		Operation: protocol.OperationObjective{
			SchemaVersion: "operation-objective/v1", Capability: "server.install", Action: "install", Target: "paper",
			Risk: "low", ExecutionEvidence: []protocol.OperationEvidenceRequirement{{Kind: "download"}},
			VerificationEvidence: []protocol.OperationEvidenceRequirement{{Kind: "verification"}},
		},
		Steps:      []protocol.TaskStep{{ID: "s1", Tool: "server.install", Args: map[string]any{"platform": "paper"}, Risk: "low"}},
		Acceptance: []protocol.AcceptanceRule{{Type: "server_ready"}},
	}
	if err := validateOperationPlan(plan); err == nil {
		t.Fatal("low-risk auto-executing server install was accepted")
	}
}
