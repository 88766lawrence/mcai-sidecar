package connector

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

func TestResourceHealthMetricAtomPreservesCloudClauseBinding(t *testing.T) {
	intent := "Please read how long the service has been up, its processor and RAM use, and assess whether overall resource health is normal."
	clauseText := "its processor"
	atomText := "processor"
	clauseByte := strings.Index(intent, clauseText)
	atomByte := strings.Index(intent, atomText)
	if clauseByte < 0 || atomByte < 0 {
		t.Fatal("fixture spans are absent")
	}
	clauseStart := len([]rune(intent[:clauseByte]))
	atomStart := len([]rune(intent[:atomByte]))
	goalID := "sg-performance-cpu"
	atomID := "atom-performance-cpu"
	plan := protocol.TaskPlan{
		Intent: intent,
		ClauseLedger: []protocol.ClauseRoleEntry{{
			ID: "clause-cpu", SourceText: clauseText, SourceStart: clauseStart,
			SourceEnd: clauseStart + len([]rune(clauseText)), Role: "domain_goal",
			Polarity: "positive", Status: "mapped", SourceAtomIDs: []string{atomID}, SourceGoalIDs: []string{goalID},
		}},
		SourceAtoms: []protocol.SourceAtom{{
			ID: atomID, SourceText: atomText, SourceStart: atomStart, SourceEnd: atomStart + len([]rune(atomText)),
			Polarity: "positive", Role: "fact", Normalized: "performance.cpu", Required: true,
			Status: "mapped", SourceGoalIDs: []string{goalID}, ClauseID: "clause-cpu",
		}},
		SourceGoals: []protocol.SourceGoal{{
			ID: goalID, SourceText: atomText, SourceStart: atomStart, SourceEnd: atomStart + len([]rune(atomText)),
			Normalized: "performance.cpu", Domain: "performance", Entity: "cpu", ResultKind: "fact",
			DependsOn: []string{}, Required: true, Status: "mapped",
		}},
	}
	plan.ClauseLedgerDigest = clauseLedgerDigest(plan.Intent, plan.ClauseLedger)
	if err := validateClauseRoleLedger(plan); err != nil {
		t.Fatalf("Cloud resource-health atom projection rejected by Go zero-trust ledger: %v", err)
	}
}

func TestGeneratedCanonicalPolicyFactsAreComplete(t *testing.T) {
	if generatedPolicySchema != "operation-policy/v2" || len(generatedPolicyDigest) != 64 {
		t.Fatalf("invalid generated policy identity: %s %s", generatedPolicySchema, generatedPolicyDigest)
	}
	for tool, policy := range generatedToolPolicies {
		if policy.action == "" || policy.minimumRisk == "" || policy.evidenceKind == "" {
			t.Fatalf("canonical policy for %s is incomplete: %#v", tool, policy)
		}
		if policy.producerVerified {
			if tool != "file.download" || !policy.mutates || policy.action != "write" || policy.minimumRisk != "low" || policy.requiresConfirmation {
				t.Fatalf("invalid producer-verified policy for %s: %#v", tool, policy)
			}
			continue
		}
		if policy.mutates != policy.requiresConfirmation && policy.minimumRisk != "high" {
			t.Fatalf("canonical mutation/confirmation facts drifted for %s", tool)
		}
	}
	if !generatedToolPolicies["file.download"].producerVerified {
		t.Fatal("file.download lost its producer-owned verification boundary")
	}
}

func TestCanonicalMixedActionVectors(t *testing.T) {
	for _, vector := range generatedActionVectors {
		t.Run(vector.name, func(t *testing.T) {
			action := "read"
			for _, tool := range vector.tools {
				step := protocol.TaskStep{Tool: tool, Args: map[string]any{}}
				if tool == "console.command" {
					step.Args["command"] = vector.consoleCommand
				}
				policy, err := policyForStep(step)
				if err != nil {
					t.Fatal(err)
				}
				action = combineActions(action, policy.action)
			}
			if action != vector.expected {
				t.Fatalf("derived action %s, expected %s", action, vector.expected)
			}
		})
	}
}

func TestCloudAcceptedCanonicalReadDiagnosePlanIsAgentCompatible(t *testing.T) {
	steps := []protocol.TaskStep{
		{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "version"}, Risk: "read"},
		{ID: "s2", Tool: "logs.query", Args: map[string]any{"window_minutes": float64(15)}, Risk: "read"},
	}
	if got := combineActions("read", generatedToolPolicies["logs.query"].action); got != "diagnose" {
		t.Fatalf("read+diagnose drifted to %s", got)
	}
	for _, step := range steps {
		if _, err := policyForStep(step); err != nil {
			t.Fatalf("canonical Cloud step rejected by Agent: %v", err)
		}
	}
}

func TestConfigInspectMultiKeyEnvelopeRemainsCanonicalRead(t *testing.T) {
	step := protocol.TaskStep{
		ID: "s1", Tool: "config.inspect", Risk: "read",
		Args: map[string]any{"path": "config/engine.properties", "keys": []any{"alpha-mode", "cache.limit"}},
	}
	policy, err := policyForStep(step)
	if err != nil {
		t.Fatalf("canonical multi-key config read rejected: %v", err)
	}
	if policy.action != "read" || policy.minimumRisk != "read" || policy.requiresConfirmation || policy.mutates {
		t.Fatalf("config read policy drifted: %#v", policy)
	}
}

func TestCloudConfigReadConstraintFixtureIsAgentCompatible(t *testing.T) {
	raw := `{"schema_version":"task-plan/v1","policy_version":"operation-policy/v2:67b0f8f1d69a9b0f10f9402e285596fa92c650ec0aefe2b5b56c9a605bc96f4b","policy_digest":"67b0f8f1d69a9b0f10f9402e285596fa92c650ec0aefe2b5b56c9a605bc96f4b","task_id":"fixture-config-read-constraint","instance_ref":"mcs:daemon:instance","intent":"QA0060-A5验收：只读看看server.properties里的view-distance和simulation-distance现在各是多少，别改。","inventory_revision":"revision-constraint","operation":{"schema_version":"operation-objective/v2","digest":"748a49af8eb12537dd67e032033e9f81ae58deb38b8ca6df11ebd3c242eeb842","capability":"config.inspect","action":"read","target":"server.properties","parameters":{"path":"server.properties","keys":["view-distance","simulation-distance"]},"risk":"read","requires_confirmation":false,"execution_evidence":[{"kind":"config","step_id":"s1","tool":"config.inspect","target":"server.properties","parameters":{"keys":["view-distance","simulation-distance"],"path":"server.properties"},"order":0}],"verification_evidence":[{"kind":"verification","step_id":"terminal","tool":"terminal","target":"server.properties","parameters":{},"order":1}],"recovery":"retry-read"},"clause_ledger":[{"id":"clause-1","source_text":"QA0060-A5验收：只读看看server.properties里的view-distance和simulation-distance现在各是多少","source_start":0,"source_end":74,"role":"domain_goal","polarity":"positive","status":"mapped","reason":"mapped_by_typed_source_goal_trace","source_atom_ids":["atom-sg-1-config-value-server-properties-view-distance","atom-sg-2-config-value-server-properties-simulation-distance"],"source_goal_ids":["sg-1-config-value-server-properties-view-distance","sg-2-config-value-server-properties-simulation-distance"],"constraint_actions":[]},{"id":"clause-2","source_text":"别改","source_start":75,"source_end":77,"role":"safety_constraint","polarity":"negative","status":"mapped","reason":"mapped_to_plan_constraint","source_atom_ids":["atom-constraint-3-write"],"source_goal_ids":[],"constraint_actions":["write"]}],"clause_ledger_digest":"c60dc51889eb55f17d7b01897e1971d40f453ded28088fa1d39dd9d96f217509","evidence_policy":{"require_real_callback_per_goal":false,"require_independent_verification":false,"clause_ids":[]},"response_policy":{"cover_all_required_goals":false,"require_synthesis":false,"clause_ids":[]},"source_atoms":[{"id":"atom-sg-1-config-value-server-properties-view-distance","source_text":"view-distance","source_start":35,"source_end":48,"polarity":"positive","role":"fact","normalized":"config.value:server.properties:view-distance","required":true,"status":"mapped","source_goal_ids":["sg-1-config-value-server-properties-view-distance"],"reason":"mapped_to_typed_source_goal","clause_id":"clause-1"},{"id":"atom-sg-2-config-value-server-properties-simulation-distance","source_text":"simulation-distance","source_start":49,"source_end":68,"polarity":"positive","role":"fact","normalized":"config.value:server.properties:simulation-distance","required":true,"status":"mapped","source_goal_ids":["sg-2-config-value-server-properties-simulation-distance"],"reason":"mapped_to_typed_source_goal","clause_id":"clause-1"},{"id":"atom-constraint-3-write","source_text":"别改","source_start":75,"source_end":77,"polarity":"negative","role":"constraint","normalized":"constraint.forbid:write","required":false,"status":"mapped","source_goal_ids":[],"reason":"mapped_to_plan_constraint","clause_id":"clause-2"}],"source_atom_digest":"d1a3f65b731fff01034d5d3285b3330b43b9d0fff7628e55b830b2093a1dcff3","source_goals":[{"id":"sg-1-config-value-server-properties-view-distance","source_text":"view-distance","source_start":35,"source_end":48,"normalized":"config.value:server.properties:view-distance","domain":"config","entity":"server.properties#view-distance","result_kind":"fact","required":true,"depends_on":[],"status":"mapped"},{"id":"sg-2-config-value-server-properties-simulation-distance","source_text":"simulation-distance","source_start":49,"source_end":68,"normalized":"config.value:server.properties:simulation-distance","domain":"config","entity":"server.properties#simulation-distance","result_kind":"fact","required":true,"depends_on":[],"status":"mapped"}],"source_goal_digest":"b1f3f1b81c1092fcfb68aa73042e040f0fee4510acc216d85707be97847e27b5","goal_requirements":[{"id":"g-sg-1-config-value-server-properties-view-distance","description":"Read view-distance from server.properties","domain":"config","action":"read","target":"server.properties#view-distance","required":true,"source_goal_ids":["sg-1-config-value-server-properties-view-distance"],"result_kind":"fact","execute_step_ids":["s1"],"verify_step_ids":[],"evidence":[{"kind":"config","step_id":"s1","tool":"config.inspect","target":"server.properties","parameters":{"keys":["view-distance","simulation-distance"],"path":"server.properties"},"order":0},{"kind":"verification","step_id":"terminal","tool":"terminal","target":"server.properties","parameters":{},"order":1}],"status":"pending"},{"id":"g-sg-2-config-value-server-properties-simulation-distance","description":"Read simulation-distance from server.properties","domain":"config","action":"read","target":"server.properties#simulation-distance","required":true,"source_goal_ids":["sg-2-config-value-server-properties-simulation-distance"],"result_kind":"fact","execute_step_ids":["s1"],"verify_step_ids":[],"evidence":[{"kind":"config","step_id":"s1","tool":"config.inspect","target":"server.properties","parameters":{"keys":["view-distance","simulation-distance"],"path":"server.properties"},"order":0},{"kind":"verification","step_id":"terminal","tool":"terminal","target":"server.properties","parameters":{},"order":1}],"status":"pending"}],"constraints":[{"action":"write","effect":"forbid","source":"别改","source_start":75,"source_end":77,"clause_id":"clause-2"}],"coverage":"full","steps":[{"id":"s1","tool":"config.inspect","args":{"path":"server.properties","keys":["view-distance","simulation-distance"]},"risk":"read"}],"acceptance":[]}`
	var plan protocol.TaskPlan
	if err := json.Unmarshal([]byte(raw), &plan); err != nil {
		t.Fatal(err)
	}
	// The fixture exercises clause/constraint compatibility. Bind it to the
	// current generated policy so an intentional policy extension (for
	// example another medium-risk console verb) does not turn this semantic
	// fixture into a stale policy-version test.
	plan.PolicyVersion = generatedPolicyVersion
	plan.PolicyDigest = generatedPolicyDigest
	if err := validateOperationPlan(plan); err != nil {
		t.Fatalf("complete Cloud config-read plan rejected by Agent: %v", err)
	}
	if len(plan.ClauseLedger) != 2 || plan.ClauseLedger[0].Role != "domain_goal" || plan.ClauseLedger[0].Polarity != "positive" || plan.ClauseLedger[1].Role != "safety_constraint" || plan.ClauseLedger[1].Polarity != "negative" || len(plan.ClauseLedger[1].SourceGoalIDs) != 0 {
		t.Fatalf("fixture lost positive-goal/negative-constraint separation: %#v", plan.ClauseLedger)
	}
	tampered := plan
	tampered.Constraints = nil
	if err := validateOperationPlan(tampered); err == nil {
		t.Fatal("Agent trusted Cloud after the source-bound write prohibition was removed")
	}
}

func TestTypedPredicateRejectsDomainAndSchemaDrift(t *testing.T) {
	collection := protocol.SourceGoal{
		ID: "sg-files", Domain: "filesystem", Entity: "/bundles/review", ResultKind: "collection",
		ItemSchema: map[string]string{"name": "string", "path": "string"},
	}
	owner := protocol.SourceGoal{ID: "sg-check", Domain: "filesystem", Entity: "/bundles/review", ResultKind: "judgement"}
	valid := &protocol.GoalPredicate{
		SchemaVersion: "goal-predicate/v1", Operator: "all_match", Expected: true,
		Operands: []protocol.GoalPredicateOperand{{
			GoalID: "sg-files", Selector: "observed", Domain: "filesystem", Entity: "/bundles/review", ResultKind: "collection",
			Filter: &protocol.SourceGoalFilter{Field: "name", Operator: "suffix", Value: ".zip"},
		}},
	}
	sources := map[string]protocol.SourceGoal{"sg-files": collection, "sg-check": owner}
	if err := validateTypedPredicate(valid, owner, sources); err != nil {
		t.Fatalf("valid typed predicate rejected: %v", err)
	}

	wrongDomain := *valid
	wrongDomain.Operands = append([]protocol.GoalPredicateOperand(nil), valid.Operands...)
	wrongDomain.Operands[0].Domain = "players"
	if err := validateTypedPredicate(&wrongDomain, owner, sources); err == nil {
		t.Fatal("cross-domain predicate was accepted")
	}

	wrongField := *valid
	wrongField.Operands = append([]protocol.GoalPredicateOperand(nil), valid.Operands...)
	wrongField.Operands[0].Filter = &protocol.SourceGoalFilter{Field: "playerName", Operator: "suffix", Value: ".zip"}
	if err := validateTypedPredicate(&wrongField, owner, sources); err == nil {
		t.Fatal("unknown collection field was accepted")
	}

	numeric := &protocol.GoalPredicate{
		SchemaVersion: "goal-predicate/v1", Operator: "lt", Expected: true,
		Operands: []protocol.GoalPredicateOperand{{GoalID: "sg-files", Domain: "filesystem", Entity: "/bundles/review", ResultKind: "collection"}, {Value: float64(3)}},
	}
	if err := validateTypedPredicate(numeric, owner, sources); err == nil {
		t.Fatal("numeric comparison over a collection was accepted")
	}
}

func TestTypedPredicateAcceptsAuditableFactComparisons(t *testing.T) {
	sources := map[string]protocol.SourceGoal{
		"sg-difficulty": {
			ID: "sg-difficulty", Domain: "world", Entity: "difficulty", ResultKind: "fact", Required: true,
		},
		"sg-daytime": {
			ID: "sg-daytime", Domain: "world", Entity: "daytime", ResultKind: "fact", Required: true,
		},
	}
	cases := []struct {
		name      string
		owner     protocol.SourceGoal
		predicate *protocol.GoalPredicate
	}{
		{
			name:  "string fact equality",
			owner: protocol.SourceGoal{ID: "sg-peaceful", Domain: "world", Entity: "difficulty", ResultKind: "judgement", SourceText: "difficulty equals peaceful", SourceStart: 0, SourceEnd: 26},
			predicate: &protocol.GoalPredicate{
				SchemaVersion: "goal-predicate/v2", Operator: "equals", Expected: true,
				Operands: []protocol.GoalPredicateOperand{
					{GoalID: "sg-difficulty", Domain: "world", Entity: "difficulty", ResultKind: "fact", SourceText: "difficulty", SourceStart: 0, SourceEnd: 10, SourceRole: "left"},
					{Value: "peaceful", SourceText: "peaceful", SourceStart: 18, SourceEnd: 26, SourceRole: "right"},
				},
			},
		},
		{
			name:  "numeric fact comparison",
			owner: protocol.SourceGoal{ID: "sg-day", Domain: "world", Entity: "daytime", ResultKind: "judgement", SourceText: "daytime less than 12000", SourceStart: 0, SourceEnd: 23},
			predicate: &protocol.GoalPredicate{
				SchemaVersion: "goal-predicate/v2", Operator: "lt", Expected: true,
				Operands: []protocol.GoalPredicateOperand{
					{GoalID: "sg-daytime", Domain: "world", Entity: "daytime", ResultKind: "fact", SourceText: "daytime", SourceStart: 0, SourceEnd: 7, SourceRole: "left"},
					{Value: float64(12000), SourceText: "12000", SourceStart: 18, SourceEnd: 23, SourceRole: "right"},
				},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.predicate.Left = &tc.predicate.Operands[0]
			tc.predicate.Right = &tc.predicate.Operands[1]
			if err := validateTypedPredicate(tc.predicate, tc.owner, sources); err != nil {
				t.Fatalf("auditable fact comparison rejected: %v", err)
			}
		})
	}
}

func TestRuntimeDaytimePlanMatchesCloudProjection(t *testing.T) {
	intent := "读取主世界现有daytime刻数，再据此判断昼间或夜间，禁止改变时间。"
	step := protocol.TaskStep{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "time query daytime"}, Risk: "read"}
	execution := protocol.OperationEvidenceRequirement{Kind: "console", StepID: "s1", Tool: "console.command", Target: "time query daytime", Parameters: map[string]any{"command": "time query daytime"}, Order: 0}
	verification := protocol.OperationEvidenceRequirement{Kind: "verification", StepID: "terminal", Tool: "terminal", Target: "time query daytime", Parameters: map[string]any{}, Order: 1}
	left := protocol.GoalPredicateOperand{GoalID: "sg-1-world-daytime", Selector: "observed", Domain: "world", Entity: "world.daytime", ResultKind: "fact", SourceText: "昼间或夜间", SourceStart: 22, SourceEnd: 27, SourceRole: "left"}
	right := protocol.GoalPredicateOperand{Value: float64(13000), SourceText: "昼间或夜间", SourceStart: 22, SourceEnd: 27, SourceRole: "right"}
	sourcePredicate := &protocol.GoalPredicate{SchemaVersion: "goal-predicate/v2", Operator: "lt", Left: &left, Right: &right, Operands: []protocol.GoalPredicateOperand{left, right}, Expected: true}
	goalLeft := left
	goalLeft.GoalID = "g-sg-1-world-daytime"
	goalPredicate := &protocol.GoalPredicate{SchemaVersion: "goal-predicate/v2", Operator: "lt", Left: &goalLeft, Right: &right, Operands: []protocol.GoalPredicateOperand{goalLeft, right}, Expected: true}
	plan := protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", PolicyVersion: generatedPolicyVersion, PolicyDigest: generatedPolicyDigest,
		TaskID: "runtime-daytime", InstanceRef: "mcs:test", InventoryRevision: "rev-test", Intent: intent, Coverage: "full", Steps: []protocol.TaskStep{step},
		Operation: protocol.OperationObjective{SchemaVersion: "operation-objective/v2", Capability: "console.command", Action: "read", Target: "time query daytime", Parameters: map[string]any{"command": "time query daytime"}, Risk: "read", ExecutionEvidence: []protocol.OperationEvidenceRequirement{execution}, VerificationEvidence: []protocol.OperationEvidenceRequirement{verification}, Recovery: "retry-read"},
		ClauseLedger: []protocol.ClauseRoleEntry{
			{ID: "clause-1", SourceText: "读取主世界现有daytime刻数", SourceStart: 0, SourceEnd: 16, Role: "domain_goal", Polarity: "positive", Status: "mapped", Reason: "eligible_for_source_goal_mapping", SourceAtomIDs: []string{"atom-sg-1-world-daytime"}, SourceGoalIDs: []string{"sg-1-world-daytime"}},
			{ID: "clause-2", SourceText: "再据此判断昼间或夜间", SourceStart: 17, SourceEnd: 27, Role: "domain_goal", Polarity: "positive", Status: "mapped", Reason: "eligible_for_source_goal_mapping", SourceAtomIDs: []string{"atom-sg-2-world-day-period"}, SourceGoalIDs: []string{"sg-2-world-day-period"}},
			{ID: "clause-3", SourceText: "禁止改变时间", SourceStart: 28, SourceEnd: 34, Role: "safety_constraint", Polarity: "negative", Status: "mapped", Reason: "mapped_to_plan_constraint", SourceAtomIDs: []string{"atom-constraint-3-write"}, ConstraintActions: []string{"write"}},
		},
		SourceAtoms: []protocol.SourceAtom{
			{ID: "atom-sg-1-world-daytime", SourceText: "读取主世界现有daytime刻数", SourceStart: 0, SourceEnd: 16, Polarity: "positive", Role: "fact", Normalized: "world.daytime", Required: true, Status: "mapped", SourceGoalIDs: []string{"sg-1-world-daytime"}, Reason: "mapped_to_typed_source_goal", ClauseID: "clause-1"},
			{ID: "atom-sg-2-world-day-period", SourceText: "昼间或夜间", SourceStart: 22, SourceEnd: 27, Polarity: "positive", Role: "judgement", Normalized: "world.day-period", Required: true, Status: "mapped", SourceGoalIDs: []string{"sg-2-world-day-period"}, Reason: "mapped_to_typed_source_goal", ClauseID: "clause-2"},
			{ID: "atom-constraint-3-write", SourceText: "禁止改变时间", SourceStart: 28, SourceEnd: 34, Polarity: "negative", Role: "constraint", Normalized: "constraint.forbid:write", Status: "mapped", Reason: "mapped_to_plan_constraint", ClauseID: "clause-3"},
		},
		SourceGoals: []protocol.SourceGoal{
			{ID: "sg-1-world-daytime", SourceText: "读取主世界现有daytime刻数", SourceStart: 0, SourceEnd: 16, Normalized: "world.daytime", Domain: "world", Entity: "world.daytime", ResultKind: "fact", Required: true, Status: "mapped"},
			{ID: "sg-2-world-day-period", SourceText: "昼间或夜间", SourceStart: 22, SourceEnd: 27, Normalized: "world.day-period", Domain: "world", Entity: "world.daytime", ResultKind: "judgement", Required: true, DependsOn: []string{"sg-1-world-daytime"}, Status: "mapped", Predicate: sourcePredicate},
		},
		GoalRequirements: []protocol.GoalRequirement{
			{ID: "g-sg-1-world-daytime", Description: "读取当前世界时间刻数", Domain: "world", Action: "read", Target: "world.daytime", Required: true, SourceGoalIDs: []string{"sg-1-world-daytime"}, ResultKind: "fact", ExecuteStepIDs: []string{"s1"}, Evidence: []protocol.OperationEvidenceRequirement{execution, verification}, Status: "pending"},
			{ID: "g-sg-2-world-day-period", Description: "综合判断：白天还是夜晚", Domain: "world", Action: "read", Target: "world.daytime", Required: true, SourceGoalIDs: []string{"sg-2-world-day-period"}, ResultKind: "judgement", Predicate: goalPredicate, DependsOnGoalIDs: []string{"g-sg-1-world-daytime"}, ExecuteStepIDs: []string{"s1"}, Evidence: []protocol.OperationEvidenceRequirement{execution, verification}, Status: "pending"},
		},
		Constraints: []protocol.PlanConstraint{{Action: "write", Effect: "forbid", Source: "禁止改变时间", SourceStart: 28, SourceEnd: 34, ClauseID: "clause-3"}},
	}
	plan.Operation.Digest = operationDigest(plan.Steps)
	plan.ClauseLedgerDigest = clauseLedgerDigest(plan.Intent, plan.ClauseLedger)
	plan.SourceAtomDigest = sourceAtomDigest(plan.Intent, plan.SourceAtoms)
	plan.SourceGoalDigest = sourceGoalLedgerDigest(plan.Intent, plan.SourceAtoms, plan.SourceGoals)
	if err := validateOperationPlan(plan); err != nil {
		t.Fatalf("Cloud runtime daytime plan rejected: %v", err)
	}
}

func TestResourcePressureJudgementRequiresExactCPUAndMemoryFacts(t *testing.T) {
	cpu := protocol.SourceGoal{ID: "sg-cpu", Normalized: "performance.cpu", Domain: "performance", Entity: "cpu", ResultKind: "fact", Required: true, Status: "mapped"}
	memory := protocol.SourceGoal{ID: "sg-memory", Normalized: "performance.memory", Domain: "performance", Entity: "memory", ResultKind: "fact", Required: true, Status: "mapped"}
	pressure := protocol.SourceGoal{ID: "sg-pressure", Normalized: "performance.pressure", Domain: "performance", Entity: "resource-pressure", ResultKind: "judgement", DependsOn: []string{cpu.ID, memory.ID}, Required: true, Status: "mapped"}
	sources := map[string]protocol.SourceGoal{cpu.ID: cpu, memory.ID: memory, pressure.ID: pressure}
	if err := validateResourcePressureSource(pressure, sources); err != nil {
		t.Fatalf("valid versioned resource pressure judgement rejected: %v", err)
	}

	wrong := pressure
	wrong.DependsOn = []string{cpu.ID, cpu.ID}
	if err := validateResourcePressureSource(wrong, sources); err == nil {
		t.Fatal("duplicate CPU dependency was accepted as CPU plus memory")
	}

	wrong = pressure
	wrong.Entity = "players"
	if err := validateResourcePressureSource(wrong, sources); err == nil {
		t.Fatal("cross-domain resource pressure judgement was accepted")
	}

	wrong = pressure
	wrong.Predicate = &protocol.GoalPredicate{SchemaVersion: "goal-predicate/v1", Operator: "equals"}
	if err := validateResourcePressureSource(wrong, sources); err == nil {
		t.Fatal("an untrusted generic predicate was accepted for resource pressure")
	}
}

func TestSupportingCollectionMustRemainExactAndTraceable(t *testing.T) {
	intent := "Count .cfg entries in '/vault/safe'"
	collection := protocol.SourceGoal{
		ID: "sg-support", SourceText: intent, SourceStart: 0, SourceEnd: len([]rune(intent)),
		Normalized: "support.collection:/vault/safe", Domain: "filesystem", Entity: "/vault/safe", ResultKind: "collection",
		ItemSchema: map[string]string{"name": "string", "path": "string", "type": "string"}, Required: false, Status: "mapped",
	}
	filtered := protocol.SourceGoal{
		ID: "sg-filtered", SourceText: intent, SourceStart: 0, SourceEnd: len([]rune(intent)),
		Normalized: "filesystem.filtered-count:/vault/safe:.cfg", Domain: "filesystem", Entity: "/vault/safe", ResultKind: "filtered_count",
		Filter: &protocol.SourceGoalFilter{Field: "name", Operator: "suffix", Value: ".cfg"}, DependsOn: []string{"sg-support"}, Required: true, Status: "mapped",
	}
	plan := protocol.TaskPlan{
		Intent: intent, SourceGoals: []protocol.SourceGoal{collection, filtered},
		GoalRequirements: []protocol.GoalRequirement{
			{ID: "g-support", Domain: "filesystem", Target: "/vault/safe", ResultKind: "collection", SourceGoalIDs: []string{"sg-support"}, Supporting: true, SupportReason: "collection_required_for_filtered_count", SupportsSourceGoalIDs: []string{"sg-filtered"}},
			{ID: "g-filtered", Domain: "filesystem", Target: "/vault/safe", ResultKind: "filtered_count", SourceGoalIDs: []string{"sg-filtered"}, Required: true, DependsOnGoalIDs: []string{"g-support"}},
		},
	}
	plan.SourceAtoms = []protocol.SourceAtom{{ID: "atom-filtered", SourceText: intent, SourceStart: 0, SourceEnd: len([]rune(intent)), Polarity: "positive", Role: "filtered_count", Normalized: filtered.Normalized, Required: true, Status: "mapped", SourceGoalIDs: []string{"sg-filtered"}, Reason: "mapped_to_typed_source_goal"}}
	plan.SourceAtomDigest = sourceAtomDigest(plan.Intent, plan.SourceAtoms)
	plan.SourceGoalDigest = sourceGoalLedgerDigest(plan.Intent, plan.SourceAtoms, plan.SourceGoals)
	if err := validateSourceGoalBindings(plan); err != nil {
		t.Fatalf("valid exact supporting collection rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*protocol.TaskPlan)
	}{
		{"parent scope", func(p *protocol.TaskPlan) { p.GoalRequirements[0].Target = "/vault" }},
		{"untraced support", func(p *protocol.TaskPlan) {
			p.SourceGoals[1].DependsOn = nil
			p.SourceGoalDigest = sourceGoalDigest(p.Intent, p.SourceGoals)
		}},
		{"missing reason", func(p *protocol.TaskPlan) { p.GoalRequirements[0].SupportReason = "" }},
		{"support made required", func(p *protocol.TaskPlan) {
			p.SourceGoals[0].Required = true
			p.SourceGoalDigest = sourceGoalDigest(p.Intent, p.SourceGoals)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			copyPlan := plan
			copyPlan.SourceGoals = append([]protocol.SourceGoal(nil), plan.SourceGoals...)
			copyPlan.GoalRequirements = append([]protocol.GoalRequirement(nil), plan.GoalRequirements...)
			tt.mutate(&copyPlan)
			if err := validateSourceGoalBindings(copyPlan); err == nil {
				t.Fatal("invalid supporting scope was accepted")
			}
		})
	}
}

func TestCanonicalCollectionIdentityRejectsDuplicateSourceNodes(t *testing.T) {
	intent := "List '/mnt/relay/cache-index' entries"
	span := len([]rune(intent))
	first := protocol.SourceGoal{ID: "sg-a", SourceText: intent, SourceStart: 0, SourceEnd: span, Normalized: "filesystem.collection:/mnt/relay/cache-index", Domain: "filesystem", Entity: "/mnt/relay/cache-index", ResultKind: "collection", ItemSchema: map[string]string{"name": "string", "path": "string", "type": "string"}, Required: true, Status: "mapped"}
	second := first
	second.ID = "sg-b"
	plan := protocol.TaskPlan{Intent: intent, SourceGoals: []protocol.SourceGoal{first, second}}
	plan.SourceAtoms = []protocol.SourceAtom{
		{ID: "atom-a", SourceText: intent, SourceStart: 0, SourceEnd: span, Polarity: "positive", Role: "collection", Normalized: first.Normalized, Required: true, Status: "mapped", SourceGoalIDs: []string{"sg-a"}, Reason: "mapped_to_typed_source_goal"},
		{ID: "atom-b", SourceText: intent, SourceStart: 0, SourceEnd: span, Polarity: "positive", Role: "collection", Normalized: second.Normalized, Required: true, Status: "mapped", SourceGoalIDs: []string{"sg-b"}, Reason: "mapped_to_typed_source_goal"},
	}
	plan.SourceAtomDigest = sourceAtomDigest(plan.Intent, plan.SourceAtoms)
	plan.SourceGoalDigest = sourceGoalLedgerDigest(plan.Intent, plan.SourceAtoms, plan.SourceGoals)
	if err := validateSourceGoalBindings(plan); err == nil || err.Error() != "the same canonical collection appears more than once" {
		t.Fatalf("duplicate canonical collection was not rejected precisely: %v", err)
	}
}

func TestReadonlyObservationCanBeIndependentlyRechecked(t *testing.T) {
	execute := protocol.TaskStep{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "version"}, Risk: "read"}
	policy, err := policyForStep(execute)
	if err != nil {
		t.Fatal(err)
	}
	verification := protocol.TaskStep{ID: "s2", Tool: "console.command", Args: map[string]any{"command": "version"}, Risk: "read", Purpose: "verify"}
	if !verificationMatches(pendingExecution{step: execute, policy: policy}, verification) {
		t.Fatal("compatible second read was rejected")
	}
	verification.Args["command"] = "list"
	if verificationMatches(pendingExecution{step: execute, policy: policy}, verification) {
		t.Fatal("cross-target read verification was accepted")
	}
}

func TestDirectedPredicateV2QuantifierVectors(t *testing.T) {
	collection := protocol.SourceGoal{ID: "sg-collection", Domain: "filesystem", Entity: "/var/vector/items", ResultKind: "collection", ItemSchema: map[string]string{"name": "string"}}
	owner := protocol.SourceGoal{ID: "sg-judgement", SourceText: "any .vec", SourceStart: 0, SourceEnd: 8, Domain: "filesystem", Entity: "/var/vector/items", ResultKind: "judgement"}
	sources := map[string]protocol.SourceGoal{collection.ID: collection, owner.ID: owner}
	filter := &protocol.SourceGoalFilter{Field: "name", Operator: "suffix", Value: ".vec"}
	filtered := protocol.GoalPredicateOperand{GoalID: collection.ID, Selector: "filtered_count", Filter: filter, Domain: collection.Domain, Entity: collection.Entity, ResultKind: collection.ResultKind, SourceText: ".vec", SourceStart: 4, SourceEnd: 8, SourceRole: "left"}
	total := protocol.GoalPredicateOperand{GoalID: collection.ID, Selector: "count", Domain: collection.Domain, Entity: collection.Entity, ResultKind: collection.ResultKind, SourceText: "any", SourceStart: 0, SourceEnd: 3, SourceRole: "right"}
	zero := protocol.GoalPredicateOperand{Value: float64(0), SourceText: "any", SourceStart: 0, SourceEnd: 3, SourceRole: "right"}
	any := &protocol.GoalPredicate{SchemaVersion: "goal-predicate/v2", Operator: "gt", Operands: []protocol.GoalPredicateOperand{filtered, zero}, Left: &filtered, Right: &zero, Quantifier: "any", Filter: filter, Expected: true}
	if err := validateTypedPredicate(any, owner, sources); err != nil {
		t.Fatalf("valid any vector rejected: %v", err)
	}
	all := &protocol.GoalPredicate{SchemaVersion: "goal-predicate/v2", Operator: "equals", Operands: []protocol.GoalPredicateOperand{filtered, total}, Left: &filtered, Right: &total, Quantifier: "all", Filter: filter, Expected: true}
	if err := validateTypedPredicate(all, owner, sources); err != nil {
		t.Fatalf("valid all vector rejected: %v", err)
	}
	swapped := *any
	swapped.Operands = []protocol.GoalPredicateOperand{zero, filtered}
	swapped.Left, swapped.Right = &zero, &filtered
	if err := validateTypedPredicate(&swapped, owner, sources); err == nil {
		t.Fatal("swapped any operands were accepted")
	}
	for _, operator := range []string{"equals", "not_equals", "lt", "lte", "gt", "gte"} {
		directedOwner := protocol.SourceGoal{ID: "sg-directed", SourceText: "2 < 3", SourceStart: 0, SourceEnd: 5, Domain: "derived", Entity: "comparison", ResultKind: "judgement"}
		left := protocol.GoalPredicateOperand{Value: float64(2), SourceText: "2", SourceStart: 0, SourceEnd: 1, SourceRole: "left"}
		right := protocol.GoalPredicateOperand{Value: float64(3), SourceText: "3", SourceStart: 4, SourceEnd: 5, SourceRole: "right"}
		predicate := &protocol.GoalPredicate{SchemaVersion: "goal-predicate/v2", Operator: operator, Operands: []protocol.GoalPredicateOperand{left, right}, Left: &left, Right: &right, Expected: true}
		if err := validateTypedPredicate(predicate, directedOwner, sources); err != nil {
			t.Fatalf("directed comparison %s rejected: %v", operator, err)
		}
		predicate.Operands[0], predicate.Operands[1] = predicate.Operands[1], predicate.Operands[0]
		if err := validateTypedPredicate(predicate, directedOwner, sources); err == nil {
			t.Fatalf("comparison %s accepted reordered operands without matching left/right", operator)
		}
	}
}

func TestSourceAtomAndPredicateDigestMatchesCloudV2Vector(t *testing.T) {
	raw := `{"intent":"Show '/var/vector/items' entries and determine whether any name ends in .vec.","source_atoms":[{"id":"atom-sg-1-filesystem-collection-var-vector-items","source_text":"/var/vector/items","source_start":6,"source_end":23,"polarity":"positive","role":"collection","normalized":"filesystem.collection:/var/vector/items","required":true,"status":"mapped","source_goal_ids":["sg-1-filesystem-collection-var-vector-items"],"reason":"mapped_to_typed_source_goal","clause_id":"clause-1"},{"id":"atom-sg-2-derived-judgement-37","source_text":"determine whether any name ends in .vec.","source_start":37,"source_end":77,"polarity":"positive","role":"judgement","normalized":"derived.judgement:37","required":true,"status":"mapped","source_goal_ids":["sg-2-derived-judgement-37"],"reason":"mapped_to_typed_source_goal","clause_id":"clause-2"}],"source_goals":[{"id":"sg-1-filesystem-collection-var-vector-items","source_text":"/var/vector/items","source_start":6,"source_end":23,"normalized":"filesystem.collection:/var/vector/items","domain":"filesystem","entity":"/var/vector/items","result_kind":"collection","item_schema":{"name":"string","path":"string","type":"string"},"required":true,"depends_on":[],"status":"mapped"},{"id":"sg-2-derived-judgement-37","source_text":"determine whether any name ends in .vec.","source_start":37,"source_end":77,"normalized":"derived.judgement:37","domain":"filesystem","entity":"/var/vector/items","result_kind":"judgement","required":true,"depends_on":["sg-1-filesystem-collection-var-vector-items"],"status":"mapped","predicate":{"schema_version":"goal-predicate/v2","operator":"gt","left":{"goal_id":"sg-1-filesystem-collection-var-vector-items","selector":"filtered_count","domain":"filesystem","entity":"/var/vector/items","result_kind":"collection","filter":{"field":"name","operator":"suffix","value":".vec"},"source_text":".vec","source_start":72,"source_end":76,"source_role":"left"},"right":{"value":0,"source_text":"any","source_start":55,"source_end":58,"source_role":"right"},"operands":[{"goal_id":"sg-1-filesystem-collection-var-vector-items","selector":"filtered_count","domain":"filesystem","entity":"/var/vector/items","result_kind":"collection","filter":{"field":"name","operator":"suffix","value":".vec"},"source_text":".vec","source_start":72,"source_end":76,"source_role":"left"},{"value":0,"source_text":"any","source_start":55,"source_end":58,"source_role":"right"}],"quantifier":"any","filter":{"field":"name","operator":"suffix","value":".vec"},"expected":true}}]}`
	var fixture struct {
		Intent      string                `json:"intent"`
		SourceAtoms []protocol.SourceAtom `json:"source_atoms"`
		SourceGoals []protocol.SourceGoal `json:"source_goals"`
	}
	if err := json.Unmarshal([]byte(raw), &fixture); err != nil {
		t.Fatal(err)
	}
	if got, want := sourceAtomDigest(fixture.Intent, fixture.SourceAtoms), "50b418c4f1daa19a3cff0f5f2a36e1652c152b47a4e202f3451523e72ec7d1a1"; got != want {
		t.Fatalf("Cloud/Go source atom digest drift: got %s want %s", got, want)
	}
	if got, want := sourceGoalLedgerDigest(fixture.Intent, fixture.SourceAtoms, fixture.SourceGoals), "d486d04c0c3d9827b469089cf1e57caf108b6524b32e06a5e8ba96dd5bd3ce3a"; got != want {
		t.Fatalf("Cloud/Go source goal digest drift: got %s want %s", got, want)
	}
}
