package connector

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

func typedIntentPlanFixture() protocol.TaskPlan {
	source := "Read realm build from the active shard."
	ir := protocol.ValidatedIntentIR{
		SchemaVersion: "intent-ir/v1",
		Clauses:       []protocol.IntentIRClause{{IntentIRSpan: protocol.IntentIRSpan{SourceText: source, SourceStart: 0, SourceEnd: len([]rune(source))}, ID: "c-realm", Role: "domain_goal", Polarity: "positive", Status: "mapped", Reason: "registered server fact"}},
		Goals:         []protocol.IntentIRGoal{{IntentIRSpan: protocol.IntentIRSpan{SourceText: "realm build", SourceStart: 5, SourceEnd: 16}, ID: "i-build", ClauseID: "c-realm", Domain: "server", Entity: "build", Capability: "server.version", Target: "version", Parameters: map[string]any{"command": "version"}, ResultKind: "fact", Required: true}},
		Scopes:        []protocol.IntentIRScope{}, Constraints: []protocol.IntentIRConstraint{},
		EvidenceRequirements: []protocol.IntentIREvidenceRequirement{}, ResponseRequirements: []protocol.IntentIRResponseRequirement{}, Predicates: []protocol.IntentIRPredicate{}, UnknownGoals: []protocol.IntentIRUnknownGoal{},
		Source: source, Compiler: protocol.IntentIRCompiler{ProviderModel: "fixture-compiler", Attempt: 1, DeterministicValidator: "intent-ir-validator/v1"},
	}
	refreshIntentIRDigest(&ir)
	return protocol.TaskPlan{Intent: source, IntentIR: &ir, IntentIRDigest: ir.Digest,
		SourceAtoms:      []protocol.SourceAtom{{ID: "atom-i-build", SourceText: "realm build", SourceStart: 5, SourceEnd: 16, Polarity: "positive", Role: "fact", Normalized: "server.version", Required: true, Status: "mapped", SourceGoalIDs: []string{"sg-i-build"}, ClauseID: "c-realm"}},
		SourceGoals:      []protocol.SourceGoal{{ID: "sg-i-build", SourceText: "realm build", SourceStart: 5, SourceEnd: 16, Normalized: "server.version", Domain: "server", Entity: "build", ResultKind: "fact", DependsOn: []string{}, Required: true, Status: "mapped"}},
		GoalRequirements: []protocol.GoalRequirement{{ID: "g-sg-i-build", Target: "build", Required: true, SourceGoalIDs: []string{"sg-i-build"}, ExecuteStepIDs: []string{"s1"}}},
		Steps:            []protocol.TaskStep{{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "version"}, Risk: "read"}},
	}
}

func refreshIntentIRDigest(ir *protocol.ValidatedIntentIR) {
	proposal := struct {
		SchemaVersion        string                                 `json:"schema_version"`
		Clauses              []protocol.IntentIRClause              `json:"clauses"`
		Goals                []protocol.IntentIRGoal                `json:"goals"`
		Scopes               []protocol.IntentIRScope               `json:"scopes"`
		Constraints          []protocol.IntentIRConstraint          `json:"constraints"`
		EvidenceRequirements []protocol.IntentIREvidenceRequirement `json:"evidence_requirements"`
		ResponseRequirements []protocol.IntentIRResponseRequirement `json:"response_requirements"`
		Predicates           []protocol.IntentIRPredicate           `json:"predicates"`
		UnknownGoals         []protocol.IntentIRUnknownGoal         `json:"unknown_goals"`
		SourceCatalog        *protocol.IntentSourceCatalog          `json:"source_catalog,omitempty"`
		Source               string                                 `json:"source"`
	}{ir.SchemaVersion, ir.Clauses, ir.Goals, ir.Scopes, ir.Constraints, ir.EvidenceRequirements, ir.ResponseRequirements, ir.Predicates, ir.UnknownGoals, ir.SourceCatalog, ir.Source}
	sum := sha256.Sum256(canonicalDigestJSON(proposal))
	ir.Digest = hex.EncodeToString(sum[:])
}

func TestTypedIntentIRZeroTrustValidation(t *testing.T) {
	base := typedIntentPlanFixture()
	if base.IntentIR.Digest != "fb983e9f19dbb3e20c52dc1a1c95b7768195d00dd272a58df581ee378215423b" {
		t.Fatalf("TS-Go typed intent digest drifted: %s", base.IntentIR.Digest)
	}
	if err := validateIntentIR(base); err != nil {
		t.Fatalf("valid typed intent IR rejected: %v", err)
	}
	cases := []struct {
		name   string
		mutate func(*protocol.TaskPlan)
	}{
		{"source drift", func(plan *protocol.TaskPlan) { plan.IntentIR.Source = "different" }},
		{"span drift", func(plan *protocol.TaskPlan) { plan.IntentIR.Goals[0].SourceStart++ }},
		{"role tamper", func(plan *protocol.TaskPlan) { plan.IntentIR.Clauses[0].Role = "response_requirement" }},
		{"domain tamper", func(plan *protocol.TaskPlan) { plan.IntentIR.Goals[0].Domain = "filesystem" }},
		{"capability tamper", func(plan *protocol.TaskPlan) { plan.IntentIR.Goals[0].Capability = "unregistered.realm" }},
		{"projection tamper", func(plan *protocol.TaskPlan) { plan.SourceGoals[0].Entity = "other-build" }},
		{"compiler attempt tamper", func(plan *protocol.TaskPlan) { plan.IntentIR.Compiler.Attempt = 3 }},
		{"digest tamper", func(plan *protocol.TaskPlan) { plan.IntentIR.Digest = "00"; plan.IntentIRDigest = "00" }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			plan := typedIntentPlanFixture()
			test.mutate(&plan)
			if test.name != "source drift" && test.name != "compiler attempt tamper" && test.name != "digest tamper" && test.name != "projection tamper" {
				refreshIntentIRDigest(plan.IntentIR)
				plan.IntentIRDigest = plan.IntentIR.Digest
			}
			if err := validateIntentIR(plan); err == nil {
				t.Fatal("tampered typed intent IR was accepted")
			}
		})
	}
}

func TestCompactCandidateExpandedIntentDigestMatchesTypeScript(t *testing.T) {
	source := "Read realm build from the active shard."
	ir := protocol.ValidatedIntentIR{
		SchemaVersion: "intent-ir/v1",
		Clauses:       []protocol.IntentIRClause{{IntentIRSpan: protocol.IntentIRSpan{SourceText: source, SourceStart: 0, SourceEnd: len([]rune(source))}, ID: "clause-1", Role: "domain_goal", Polarity: "positive", Status: "mapped", Reason: "registered server fact"}},
		Goals:         []protocol.IntentIRGoal{{IntentIRSpan: protocol.IntentIRSpan{SourceText: "realm build", SourceStart: 5, SourceEnd: 16}, ID: "goal-1", ClauseID: "clause-1", Domain: "server", Entity: "build", Capability: "server.version", Target: "version", Parameters: map[string]any{"command": "version"}, ResultKind: "fact", Required: true}},
		Scopes:        []protocol.IntentIRScope{}, Constraints: []protocol.IntentIRConstraint{}, EvidenceRequirements: []protocol.IntentIREvidenceRequirement{}, ResponseRequirements: []protocol.IntentIRResponseRequirement{}, Predicates: []protocol.IntentIRPredicate{}, UnknownGoals: []protocol.IntentIRUnknownGoal{},
		Source: source, Compiler: protocol.IntentIRCompiler{ProviderModel: "fixture-compiler", Attempt: 1, DeterministicValidator: "intent-ir-validator/v1"},
	}
	refreshIntentIRDigest(&ir)
	if ir.Digest != "64a0d4eee018edf5b92ab4c02f5108240b9617a96c8d1c6113fe1f71b35219f2" {
		t.Fatalf("compact candidate TS-Go digest drifted: %s", ir.Digest)
	}
}

func TestSourceRefCandidateV2ProjectionIsIndependentlyVerified(t *testing.T) {
	source := "Read quartz build."
	sourceSum := sha256.Sum256([]byte(source))
	catalog := &protocol.IntentSourceCatalog{SchemaVersion: "intent-source-catalog/v1", SourceDigest: hex.EncodeToString(sourceSum[:]), Refs: []protocol.IntentSourceRef{{ID: "src-0001", SourceStart: 0, SourceEnd: len([]rune(source)), Text: source, Order: 0}}}
	catalogBase := struct {
		SchemaVersion string                     `json:"schema_version"`
		SourceDigest  string                     `json:"source_digest"`
		Refs          []protocol.IntentSourceRef `json:"refs"`
	}{catalog.SchemaVersion, catalog.SourceDigest, catalog.Refs}
	catalogSum := sha256.Sum256(canonicalDigestJSON(catalogBase))
	catalog.Digest = hex.EncodeToString(catalogSum[:])
	ir := protocol.ValidatedIntentIR{
		SchemaVersion: "intent-ir/v1",
		Clauses:       []protocol.IntentIRClause{{IntentIRSpan: protocol.IntentIRSpan{SourceText: source, SourceStart: 0, SourceEnd: len([]rune(source)), SourceRefIDs: []string{"src-0001"}}, ID: "clause-1", Role: "domain_goal", Polarity: "positive", Status: "mapped", Reason: "registered server fact"}},
		Goals:         []protocol.IntentIRGoal{{IntentIRSpan: protocol.IntentIRSpan{SourceText: source, SourceStart: 0, SourceEnd: len([]rune(source)), SourceRefIDs: []string{"src-0001"}}, ID: "goal-1", ClauseID: "clause-1", Domain: "server", Entity: "build", Capability: "server.version", Target: "version", Parameters: map[string]any{"command": "version"}, ResultKind: "fact", Required: true}},
		Scopes:        []protocol.IntentIRScope{}, Constraints: []protocol.IntentIRConstraint{}, EvidenceRequirements: []protocol.IntentIREvidenceRequirement{}, ResponseRequirements: []protocol.IntentIRResponseRequirement{}, Predicates: []protocol.IntentIRPredicate{}, UnknownGoals: []protocol.IntentIRUnknownGoal{},
		SourceCatalog: catalog, Source: source, Compiler: protocol.IntentIRCompiler{ProviderModel: "fixture-compiler", Attempt: 1, DeterministicValidator: "intent-ir-validator/v1"},
	}
	refreshIntentIRDigest(&ir)
	if ir.Digest != "39e0eb0a62081ac852f1f44577337266ef91aaa96466543fa058b5344364b844" {
		t.Fatalf("TS-Go SourceRef v2 digest drifted: %s", ir.Digest)
	}
	plan := protocol.TaskPlan{Intent: source, IntentIR: &ir, IntentIRDigest: ir.Digest,
		SourceAtoms:      []protocol.SourceAtom{{ID: "atom-goal-1", SourceText: source, SourceStart: 0, SourceEnd: len([]rune(source)), Polarity: "positive", Role: "fact", Normalized: "server.version", Required: true, Status: "mapped", SourceGoalIDs: []string{"sg-goal-1"}, ClauseID: "clause-1"}},
		SourceGoals:      []protocol.SourceGoal{{ID: "sg-goal-1", SourceText: source, SourceStart: 0, SourceEnd: len([]rune(source)), Normalized: "server.version", Domain: "server", Entity: "build", ResultKind: "fact", Required: true, Status: "mapped"}},
		GoalRequirements: []protocol.GoalRequirement{{ID: "g-sg-goal-1", Target: "build", Required: true, SourceGoalIDs: []string{"sg-goal-1"}, ExecuteStepIDs: []string{"s1"}}}, Steps: []protocol.TaskStep{{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "version"}, Risk: "read"}}}
	if err := validateIntentIR(plan); err != nil {
		t.Fatalf("valid source-ref projection rejected: %v", err)
	}
	validCatalogDigest := plan.IntentIR.SourceCatalog.Digest
	plan.IntentIR.SourceCatalog.Digest = "00"
	refreshIntentIRDigest(plan.IntentIR)
	plan.IntentIRDigest = plan.IntentIR.Digest
	if err := validateIntentIR(plan); err == nil {
		t.Fatal("tampered source catalog digest was accepted")
	}
	plan.IntentIR.SourceCatalog.Digest = validCatalogDigest
	refreshIntentIRDigest(plan.IntentIR)
	plan.IntentIRDigest = plan.IntentIR.Digest
	plan.IntentIR.Goals[0].SourceRefIDs = []string{"src-9999"}
	refreshIntentIRDigest(plan.IntentIR)
	plan.IntentIRDigest = plan.IntentIR.Digest
	if err := validateIntentIR(plan); err == nil {
		t.Fatal("unknown source ref was accepted")
	}
}

func TestTypedIntentPolicyCoverageRequiresEveryRequiredGoal(t *testing.T) {
	goals := map[string]protocol.IntentIRGoal{
		"build":  {ID: "build", Required: true},
		"roster": {ID: "roster", Required: true},
		"note":   {ID: "note", Required: false},
	}
	if coversEveryRequiredIntentGoal([]string{"build"}, goals) {
		t.Fatal("partial per-goal policy was accepted")
	}
	if !coversEveryRequiredIntentGoal([]string{"roster", "build"}, goals) {
		t.Fatal("complete per-goal policy was rejected")
	}
}
