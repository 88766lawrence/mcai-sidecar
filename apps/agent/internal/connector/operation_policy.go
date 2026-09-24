package connector

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/mcai/sidecar-agent/internal/logquery"
	"github.com/mcai/sidecar-agent/internal/protocol"
)

type toolPolicy struct {
	action               string
	minimumRisk          string
	requiresConfirmation bool
	mutates              bool
	producerVerified     bool
	evidenceKind         string
	forbiddenActions     []string
	verification         map[string]string
}

type pendingExecution struct {
	step   protocol.TaskStep
	policy toolPolicy
}

var riskRanks = rankStrings(generatedRiskOrder)
var actionRanks = rankStrings(generatedActionOrder)

func rankStrings(values []string) map[string]int {
	result := make(map[string]int, len(values))
	for index, value := range values {
		result[value] = index
	}
	return result
}

func containsString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func policyForStep(step protocol.TaskStep) (toolPolicy, error) {
	if step.Tool == "console.command" {
		command, _ := step.Args["command"].(string)
		risk := intrinsicConsoleRisk(command)
		action := "write"
		if risk == "read" {
			action = "read"
		}
		return toolPolicy{
			action: action, minimumRisk: risk, requiresConfirmation: risk != "read", mutates: risk != "read",
			producerVerified: false,
			evidenceKind:     generatedConsoleEvidenceKind, forbiddenActions: generatedConsoleWriteForbiddenActions,
			verification: generatedConsoleVerification,
		}, nil
	}
	policy, ok := generatedToolPolicies[step.Tool]
	if !ok {
		return toolPolicy{}, fmt.Errorf("tool %q is not registered in the local operation policy", step.Tool)
	}
	return policy, nil
}

func intrinsicConsoleRisk(command string) string {
	normalized := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(command)), "minecraft:")
	fields := strings.Fields(normalized)
	if len(fields) == 0 {
		return "high"
	}
	normalized = strings.Join(fields, " ")
	verb := fields[0]
	if containsString(generatedConsoleReadExact, normalized) {
		return "read"
	}
	if containsString(generatedConsoleReadVerbs, verb) {
		return "read"
	}
	for _, pattern := range generatedConsoleReadPatterns {
		if regexp.MustCompile(pattern).MatchString(normalized) {
			return "read"
		}
	}
	if containsString(generatedConsoleMediumVerbs, verb) {
		return "medium"
	}
	for _, pattern := range generatedConsoleMediumPatterns {
		if regexp.MustCompile(pattern).MatchString(normalized) {
			return "medium"
		}
	}
	return "high"
}

func validateOperationPlan(plan protocol.TaskPlan) error {
	if plan.Operation.SchemaVersion == "operation-objective/v2" && (plan.PolicyVersion != generatedPolicyVersion || plan.PolicyDigest != generatedPolicyDigest) {
		return errors.New("task plan policy version is unsupported")
	}
	if (plan.Operation.SchemaVersion != "operation-objective/v1" && plan.Operation.SchemaVersion != "operation-objective/v2") || plan.Operation.Capability == "" || plan.Operation.Target == "" {
		return errors.New("task plan omitted a structured operation objective")
	}
	if len(plan.Steps) == 0 {
		return errors.New("operation objective contains no steps")
	}
	if plan.ExecutionMode != "" && plan.ExecutionMode != "agent_direct" {
		return errors.New("task plan contains an unsupported execution mode")
	}
	if plan.ExecutionMode == "" && plan.AgentExecution != nil {
		return errors.New("agent execution envelope is not bound to direct execution mode")
	}
	direct := plan.ExecutionMode == "agent_direct"
	if direct {
		if err := validateAgentDirectExecution(plan); err != nil {
			return err
		}
	}
	if plan.Operation.SchemaVersion == "operation-objective/v2" && !direct {
		hasConfirmedWrite := false
		for _, step := range plan.Steps {
			policy, err := policyForStep(step)
			if err != nil {
				return err
			}
			if step.Purpose != "verify" && policy.mutates {
				hasConfirmedWrite = true
			}
		}
		if hasConfirmedWrite && plan.ConfirmedOperation == nil {
			return errors.New("write operation lacks a valid confirmation projection")
		}
	}
	if plan.Operation.SchemaVersion == "operation-objective/v2" && plan.ConfirmedOperation != nil {
		return validateConfirmedOperation(plan, time.Now().UTC())
	}
	if err := validateOperationBinding(plan); err != nil {
		return err
	}
	if plan.Operation.SchemaVersion == "operation-objective/v2" && !direct {
		if plan.IntentIR != nil {
			if err := validateIntentIR(plan); err != nil {
				return err
			}
		}
		if plan.Coverage != "full" {
			return errors.New("agent refuses plans that do not cover every required goal")
		}
		if len(plan.GoalRequirements) == 0 {
			return errors.New("task plan omitted persistent goal requirements")
		}
		if err := validateClauseRoleLedger(plan); err != nil {
			return err
		}
		if err := validatePlanConstraints(plan); err != nil {
			return err
		}
	}
	if _, ok := riskRanks[plan.Operation.Risk]; !ok {
		return errors.New("operation objective contains an unknown risk")
	}

	highest := "read"
	requiresConfirmation := false
	derivedAction := "read"
	primaryTool := ""
	pendingExecutions := []pendingExecution{}
	executionKinds := map[string]bool{}
	verificationKinds := map[string]bool{}
	hasIndependentVerification := false

	for index, step := range plan.Steps {
		if err := validateRegisteredToolSchema(step); err != nil {
			return err
		}
		declaredRank, ok := riskRanks[step.Risk]
		if !ok {
			return errors.New("task step contains an unknown risk")
		}
		if step.Purpose != "" && step.Purpose != "execute" && step.Purpose != "verify" {
			return errors.New("task step contains an invalid purpose")
		}
		policy, err := policyForStep(step)
		if err != nil {
			return err
		}
		minimumRank := riskRanks[policy.minimumRisk]
		if declaredRank < minimumRank {
			return fmt.Errorf("step %s understates intrinsic %s risk as %s", step.ID, policy.minimumRisk, step.Risk)
		}
		if declaredRank > riskRanks[highest] {
			highest = step.Risk
		}

		if step.Purpose == "verify" {
			hasIndependentVerification = true
			if policy.action != "read" && policy.action != "diagnose" || step.Risk != "read" || step.RequiresConfirmation {
				return errors.New("independent verification steps must use intrinsically read-only tools")
			}
			matched := -1
			for i := len(pendingExecutions) - 1; i >= 0; i-- {
				if verificationMatches(pendingExecutions[i], step) {
					matched = i
					break
				}
			}
			if matched < 0 {
				return fmt.Errorf("verification step %s has no preceding compatible execute step", step.ID)
			}
			pendingExecutions = append(pendingExecutions[:matched], pendingExecutions[matched+1:]...)
			verificationKinds["verification."+policy.evidenceKind] = true
			continue
		}

		if primaryTool == "" {
			primaryTool = step.Tool
		}
		derivedAction = combineActions(derivedAction, policy.action)
		executionKinds[policy.evidenceKind] = true
		if policy.producerVerified {
			if !policy.mutates || policy.action != "write" || policy.minimumRisk != "low" || policy.requiresConfirmation {
				return fmt.Errorf("tool %s has an invalid producer-verified policy", step.Tool)
			}
			hasIndependentVerification = true
			verificationKinds["verification."+policy.evidenceKind] = true
		}
		pendingExecutions = append(pendingExecutions, pendingExecution{step: step, policy: policy})
		mustConfirm := minimumRank >= riskRanks["medium"] || declaredRank >= riskRanks["medium"]
		if mustConfirm && !step.RequiresConfirmation {
			return fmt.Errorf("step %s requires local confirmation for %s risk", step.ID, step.Risk)
		}
		if step.RequiresConfirmation {
			requiresConfirmation = true
		}
		_ = index
	}

	if plan.Operation.Capability != primaryTool {
		return errors.New("operation capability does not match the primary executable tool")
	}
	if plan.Operation.Action != derivedAction {
		return fmt.Errorf("operation action %s does not match locally derived %s", plan.Operation.Action, derivedAction)
	}
	if plan.Operation.Risk != highest || plan.Operation.RequiresConfirmation != requiresConfirmation {
		return errors.New("operation objective does not match locally derived plan risk and confirmation")
	}
	if requiresConfirmation && !plan.Operation.RequiresConfirmation {
		return errors.New("operation objective omitted required confirmation")
	}
	writeOperation := derivedAction == "write" || derivedAction == "install" || derivedAction == "lifecycle"
	if writeOperation && (len(plan.Operation.ExecutionEvidence) == 0 || len(plan.Operation.VerificationEvidence) == 0) {
		return errors.New("write operation omitted evidence requirements")
	}
	if writeOperation && !hasIndependentVerification && len(plan.Acceptance) == 0 {
		return errors.New("write operation omitted independent verification")
	}
	if err := validateEvidenceKinds(plan.Operation.ExecutionEvidence, executionKinds, false, len(plan.Acceptance) > 0); err != nil {
		return err
	}
	if err := validateEvidenceKinds(plan.Operation.VerificationEvidence, verificationKinds, true, len(plan.Acceptance) > 0 || !writeOperation); err != nil {
		return err
	}
	if plan.Operation.SchemaVersion == "operation-objective/v2" && !direct {
		if err := validateSourceGoalBindings(plan); err != nil {
			return err
		}
		if err := validateGoalBindings(plan); err != nil {
			return err
		}
	}
	return nil
}

func validateAgentDirectExecution(plan protocol.TaskPlan) error {
	envelope := plan.AgentExecution
	if envelope == nil || envelope.SchemaVersion != "agent-tool-execution/v1" {
		return errors.New("direct execution lacks its versioned agent envelope")
	}
	if envelope.ToolCallID == "" || len(plan.Steps) != 1 {
		return errors.New("direct execution must bind exactly one named tool call")
	}
	step := plan.Steps[0]
	if step.Purpose != "execute" || envelope.Tool != step.Tool || !sameJSON(envelope.Arguments, step.Args) {
		return errors.New("agent tool or canonical arguments changed after model selection")
	}
	if envelope.InstanceRef != plan.InstanceRef || envelope.InventoryRevision != plan.InventoryRevision || envelope.InventoryRevision == "" {
		return errors.New("agent instance or inventory revision changed after model selection")
	}
	if envelope.PolicyVersion != plan.PolicyVersion || envelope.PolicyDigest != plan.PolicyDigest {
		return errors.New("agent policy binding differs from the task plan")
	}
	digest := operationDigest(plan.Steps)
	if envelope.OperationDigest != digest || plan.Operation.Digest != digest {
		return errors.New("agent operation digest does not match the selected tool call")
	}
	if plan.Operation.SchemaVersion != "operation-objective/v2" || plan.Operation.Capability != step.Tool ||
		plan.Operation.Target != stepTarget(step) || !sameJSON(plan.Operation.Parameters, step.Args) {
		return errors.New("operation objective is not bound to the selected tool call")
	}
	if len(plan.ClauseLedger) != 0 || len(plan.SourceAtoms) != 0 || len(plan.SourceGoals) != 0 ||
		len(plan.GoalRequirements) != 0 || len(plan.Constraints) != 0 || len(plan.Acceptance) != 0 ||
		plan.IntentIR != nil {
		return errors.New("direct execution must not carry a legacy semantic gate")
	}
	if plan.Coverage != "full" {
		return errors.New("direct execution is not ready for policy validation")
	}
	return nil
}

func validateRegisteredToolSchema(step protocol.TaskStep) error {
	if step.Tool == "file.download" {
		if len(step.Args) < 2 || len(step.Args) > 3 {
			return errors.New("file.download accepts url, target, and optional sha256 only")
		}
		for key := range step.Args {
			if key != "url" && key != "target" && key != "sha256" {
				return errors.New("file.download contains an unknown argument")
			}
		}
		source, sourceOK := step.Args["url"].(string)
		target, targetOK := step.Args["target"].(string)
		parsed, err := url.Parse(source)
		if !sourceOK || !targetOK || err != nil || len(source) > 2048 || parsed.String() != source ||
			(parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
			return errors.New("file.download URL is not canonical public HTTP(S)")
		}
		if !regexp.MustCompile(`^downloads/[^/\\<>"|?*;:\x00-\x1f]{1,160}$`).MatchString(target) {
			return errors.New("file.download target must be one inert downloads filename")
		}
		if checksum, exists := step.Args["sha256"]; exists {
			value, ok := checksum.(string)
			if !ok || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(value) {
				return errors.New("file.download sha256 must be lowercase hexadecimal")
			}
		}
		return nil
	}
	if step.Tool != "players.inspect" {
		return nil
	}
	if step.Args["schema_version"] != "players-inspect/v1" || step.Args["selector"] != "first-online" {
		return errors.New("players.inspect requires its versioned first-online schema")
	}
	fields, ok := step.Args["fields"].([]any)
	if !ok {
		if typed, typedOK := step.Args["fields"].([]string); typedOK {
			fields = make([]any, len(typed))
			for index := range typed {
				fields[index] = typed[index]
			}
		}
	}
	if len(fields) != 1 || fields[0] != "gamemode" || len(step.Args) != 3 {
		return errors.New("players.inspect supports only the gamemode field")
	}
	return nil
}

func newConfirmedOperation(plan protocol.TaskPlan, confirmedAt, expiresAt time.Time) *protocol.ConfirmedOperation {
	steps := make([]protocol.ConfirmedOperationStep, 0, len(plan.Steps))
	for index, step := range plan.Steps {
		purpose := step.Purpose
		if purpose == "" {
			purpose = "execute"
		}
		steps = append(steps, protocol.ConfirmedOperationStep{ID: step.ID, Tool: step.Tool, Target: stepTarget(step), Parameters: step.Args, Order: index, Purpose: purpose, Risk: step.Risk, RequiresConfirmation: step.RequiresConfirmation})
	}
	confirmed := &protocol.ConfirmedOperation{SchemaVersion: "confirmed-operation/v1", InstanceRef: plan.InstanceRef, OperationDigest: plan.Operation.Digest, Risk: plan.Operation.Risk, RequiresConfirmation: true, Steps: steps, ScopeDigest: "fixture-scope", ConfirmedAt: confirmedAt.Format(time.RFC3339Nano), ExpiresAt: expiresAt.Format(time.RFC3339Nano)}
	confirmed.SummaryDigest = confirmedOperationSummaryDigest(*confirmed)
	return confirmed
}

func confirmedOperationSummaryDigest(confirmed protocol.ConfirmedOperation) string {
	summary := struct {
		SchemaVersion        string                            `json:"schema_version"`
		InstanceRef          string                            `json:"instance_ref"`
		OperationDigest      string                            `json:"operation_digest"`
		Risk                 string                            `json:"risk"`
		RequiresConfirmation bool                              `json:"requires_confirmation"`
		Steps                []protocol.ConfirmedOperationStep `json:"steps"`
		ScopeDigest          string                            `json:"scope_digest"`
	}{confirmed.SchemaVersion, confirmed.InstanceRef, confirmed.OperationDigest, confirmed.Risk, confirmed.RequiresConfirmation, confirmed.Steps, confirmed.ScopeDigest}
	sum := sha256.Sum256(canonicalDigestJSON(summary))
	return hex.EncodeToString(sum[:])
}

func validateConfirmedOperation(plan protocol.TaskPlan, now time.Time) error {
	confirmed := plan.ConfirmedOperation
	if confirmed == nil || confirmed.SchemaVersion != "confirmed-operation/v1" || !confirmed.RequiresConfirmation || confirmed.ScopeDigest == "" {
		return errors.New("write operation lacks a valid confirmation projection")
	}
	if confirmed.InstanceRef != plan.InstanceRef || confirmed.OperationDigest != plan.Operation.Digest || confirmed.Risk != plan.Operation.Risk {
		return errors.New("confirmed instance, operation digest, or risk changed after approval")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, confirmed.ExpiresAt)
	if err != nil || !expiresAt.After(now) {
		return errors.New("confirmed operation is expired")
	}
	if confirmed.SummaryDigest == "" || confirmed.SummaryDigest != confirmedOperationSummaryDigest(*confirmed) {
		return errors.New("confirmed operation summary digest does not match")
	}
	if len(confirmed.Steps) != len(plan.Steps) {
		return errors.New("steps were added or removed after confirmation")
	}
	highest := "read"
	writeCount := 0
	for index, step := range plan.Steps {
		projection := confirmed.Steps[index]
		purpose := step.Purpose
		if purpose == "" {
			purpose = "execute"
		}
		if projection.ID != step.ID || projection.Tool != step.Tool || projection.Target != stepTarget(step) || !sameJSON(projection.Parameters, step.Args) || projection.Order != index || projection.Purpose != purpose || projection.Risk != step.Risk || projection.RequiresConfirmation != step.RequiresConfirmation {
			return errors.New("tool, target, parameters, risk, or step order changed after confirmation")
		}
		if err := validateBasicStepSchema(step); err != nil {
			return err
		}
		policy, err := policyForStep(step)
		if err != nil {
			return err
		}
		if riskRanks[step.Risk] < riskRanks[policy.minimumRisk] {
			return errors.New("confirmed step understates intrinsic risk")
		}
		if riskRanks[step.Risk] > riskRanks[highest] {
			highest = step.Risk
		}
		if purpose != "verify" && policy.mutates {
			writeCount++
			if !step.RequiresConfirmation || !policy.requiresConfirmation {
				return errors.New("confirmed write omitted intrinsic confirmation")
			}
		}
		if purpose == "verify" && (policy.mutates || step.Risk != "read" || step.RequiresConfirmation) {
			return errors.New("confirmed verification step is not read-only")
		}
	}
	if writeCount != 1 {
		return errors.New("confirmed basic operation must contain exactly one write step")
	}
	if highest != plan.Operation.Risk || plan.Operation.Capability != plan.Steps[0].Tool || plan.Operation.Action == "read" || !plan.Operation.RequiresConfirmation {
		return errors.New("confirmed operation objective drifted from canonical steps")
	}
	if plan.Operation.Digest == "" || plan.Operation.Digest != operationDigest(plan.Steps) || plan.Operation.Target != stepTarget(plan.Steps[0]) || !sameJSON(plan.Operation.Parameters, plan.Steps[0].Args) {
		return errors.New("confirmed operation binding changed after approval")
	}
	return nil
}

func validateBasicStepSchema(step protocol.TaskStep) error {
	if step.ID == "" || step.Tool == "" || step.Args == nil {
		return errors.New("confirmed step omitted required fields")
	}
	if step.Tool == "console.command" {
		command, ok := step.Args["command"].(string)
		if !ok || strings.TrimSpace(command) == "" {
			return errors.New("console.command requires a non-empty command")
		}
		for key := range step.Args {
			if key != "command" && !(step.Purpose == "verify" && key == "expect") {
				return fmt.Errorf("console.command contains unsupported parameter %q", key)
			}
		}
	}
	if step.Tool == "logs.query" {
		if _, _, err := logquery.Parse(step.Args, true); err != nil {
			return err
		}
	}
	return nil
}

type intentCapability struct {
	domain      string
	resultKinds map[string]bool
	tool        string
}

var intentCapabilities = map[string]intentCapability{
	"server.version":            {"server", map[string]bool{"fact": true}, "console.command"},
	"server.performance":        {"server", map[string]bool{"fact": true}, "console.command"},
	"players.online":            {"players", map[string]bool{"collection": true, "count": true}, "console.command"},
	"players.inspect":           {"players", map[string]bool{"fact": true, "count": true}, "players.inspect"},
	"plugins.loaded":            {"plugin", map[string]bool{"collection": true, "count": true}, "console.command"},
	"filesystem.list":           {"filesystem", map[string]bool{"collection": true}, "files.list"},
	"filesystem.count":          {"filesystem", map[string]bool{"count": true}, ""},
	"filesystem.filtered_count": {"filesystem", map[string]bool{"filtered_count": true}, ""},
	"logs.query":                {"diagnosis", map[string]bool{"collection": true, "count": true, "fact": true}, "logs.query"},
	"config.inspect":            {"config", map[string]bool{"fact": true, "collection": true}, "config.inspect"},
	"plugin.resolve":            {"plugin", map[string]bool{"fact": true}, "plugin.resolve"},
	"plugin.install":            {"plugin", map[string]bool{"fact": true}, "plugin.install"},
	"config.patch":              {"config", map[string]bool{"fact": true}, "config.patch"},
	"server.install":            {"server", map[string]bool{"fact": true}, "server.install"},
	"instance.start":            {"instance", map[string]bool{"fact": true}, "instance.start"},
	"instance.stop":             {"instance", map[string]bool{"fact": true}, "instance.stop"},
	"instance.restart":          {"instance", map[string]bool{"fact": true}, "instance.restart"},
	"console.command":           {"console", map[string]bool{"fact": true, "collection": true, "count": true}, "console.command"},
}

func validateIntentIR(plan protocol.TaskPlan) error {
	ir := plan.IntentIR
	if ir == nil || ir.SchemaVersion != "intent-ir/v1" || ir.Source != plan.Intent || plan.IntentIRDigest == "" || plan.IntentIRDigest != ir.Digest {
		return errors.New("typed intent IR envelope or source binding is invalid")
	}
	if ir.Compiler.DeterministicValidator != "intent-ir-validator/v1" || (ir.Compiler.Attempt != 1 && ir.Compiler.Attempt != 2) || ir.Compiler.ProviderModel == "" {
		return errors.New("typed intent IR compiler metadata is invalid")
	}
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
	if hex.EncodeToString(sum[:]) != ir.Digest {
		return errors.New("typed intent IR digest does not match its canonical proposal")
	}
	runes := []rune(plan.Intent)
	clauses := map[string]protocol.IntentIRClause{}
	clauseCoverage := make([]bool, len(runes))
	allIDs := map[string]bool{}
	validSpan := func(value protocol.IntentIRSpan) bool {
		return value.SourceStart >= 0 && value.SourceEnd > value.SourceStart && value.SourceEnd <= len(runes) && string(runes[value.SourceStart:value.SourceEnd]) == value.SourceText
	}
	var validateProjection func(protocol.IntentIRSpan) bool
	if ir.SourceCatalog != nil {
		catalog := ir.SourceCatalog
		if catalog.SchemaVersion != "intent-source-catalog/v1" {
			return errors.New("typed intent source catalog version is unsupported")
		}
		sourceSum := sha256.Sum256([]byte(plan.Intent))
		if catalog.SourceDigest != hex.EncodeToString(sourceSum[:]) {
			return errors.New("typed intent source catalog source digest is invalid")
		}
		catalogBase := struct {
			SchemaVersion string                     `json:"schema_version"`
			SourceDigest  string                     `json:"source_digest"`
			Refs          []protocol.IntentSourceRef `json:"refs"`
		}{catalog.SchemaVersion, catalog.SourceDigest, catalog.Refs}
		catalogSum := sha256.Sum256(canonicalDigestJSON(catalogBase))
		if catalog.Digest != hex.EncodeToString(catalogSum[:]) {
			return errors.New("typed intent source catalog digest is invalid")
		}
		refMap := map[string]protocol.IntentSourceRef{}
		covered := make([]bool, len(runes))
		previousEnd := 0
		for index, ref := range catalog.Refs {
			expectedID := fmt.Sprintf("src-%04d", index+1)
			if ref.ID != expectedID || ref.Order != index || ref.SourceStart < previousEnd || ref.SourceStart < 0 || ref.SourceEnd <= ref.SourceStart || ref.SourceEnd > len(runes) || string(runes[ref.SourceStart:ref.SourceEnd]) != ref.Text {
				return errors.New("typed intent source catalog ref is invalid")
			}
			if _, exists := refMap[ref.ID]; exists {
				return errors.New("typed intent source catalog ref id is duplicated")
			}
			refMap[ref.ID] = ref
			for offset := ref.SourceStart; offset < ref.SourceEnd; offset++ {
				covered[offset] = true
			}
			previousEnd = ref.SourceEnd
		}
		for index, value := range runes {
			if !unicode.IsSpace(value) && !covered[index] {
				return errors.New("typed intent source catalog coverage is incomplete")
			}
		}
		validateProjection = func(value protocol.IntentIRSpan) bool {
			if len(value.SourceRefIDs) == 0 {
				return false
			}
			selected := make([]protocol.IntentSourceRef, 0, len(value.SourceRefIDs))
			for _, id := range value.SourceRefIDs {
				ref, ok := refMap[id]
				if !ok {
					return false
				}
				selected = append(selected, ref)
			}
			for index := 1; index < len(selected); index++ {
				if selected[index-1].Order >= selected[index].Order {
					return false
				}
			}
			start, end := selected[0].SourceStart, selected[len(selected)-1].SourceEnd
			return value.SourceStart == start && value.SourceEnd == end && value.SourceText == string(runes[start:end])
		}
	} else {
		validateProjection = func(protocol.IntentIRSpan) bool { return true }
	}
	claimID := func(id string) bool {
		if id == "" || allIDs[id] {
			return false
		}
		allIDs[id] = true
		return true
	}
	for _, clause := range ir.Clauses {
		if !claimID(clause.ID) || !validSpan(clause.IntentIRSpan) || !validateProjection(clause.IntentIRSpan) {
			return errors.New("typed intent clause id or Unicode span is invalid")
		}
		switch clause.Role {
		case "domain_goal", "safety_constraint", "evidence_requirement", "response_requirement", "discourse", "unknown_business_goal":
		default:
			return errors.New("typed intent clause role is unsupported")
		}
		clauses[clause.ID] = clause
		for index := clause.SourceStart; index < clause.SourceEnd; index++ {
			if clauseCoverage[index] && ir.SourceCatalog == nil {
				return errors.New("typed intent clause roles overlap")
			}
			clauseCoverage[index] = true
		}
	}
	for index, value := range runes {
		if (unicode.IsLetter(value) || unicode.IsNumber(value) || value == '_') && !clauseCoverage[index] {
			return errors.New("typed intent clause ledger omits meaningful source text")
		}
	}
	goals := map[string]protocol.IntentIRGoal{}
	identities := map[string]bool{}
	for _, goal := range ir.Goals {
		capability, ok := intentCapabilities[goal.Capability]
		if !claimID(goal.ID) || !validSpan(goal.IntentIRSpan) || !validateProjection(goal.IntentIRSpan) || !ok || capability.domain != goal.Domain || !capability.resultKinds[goal.ResultKind] || clauses[goal.ClauseID].Role != "domain_goal" {
			return errors.New("typed intent goal violates capability, role, or span binding")
		}
		identity := fmt.Sprintf("%s|%s|%s|%s|%d|%d", goal.ClauseID, goal.Domain, goal.Entity, goal.ResultKind, goal.SourceStart, goal.SourceEnd)
		if identities[identity] {
			return errors.New("typed intent goal is duplicated")
		}
		identities[identity] = true
		goals[goal.ID] = goal
	}
	for _, goal := range ir.Goals {
		for _, dependency := range goal.DependsOn {
			if dependency == goal.ID || goals[dependency].ID == "" {
				return errors.New("typed intent goal dependency is invalid")
			}
		}
		if (goal.ResultKind == "count" || goal.ResultKind == "filtered_count") && !hasCollectionDependency(goal, goals) {
			return errors.New("typed intent derived count lacks collection dependency")
		}
		if goal.ResultKind == "filtered_count" && goal.Filter == nil {
			return errors.New("typed filtered count lacks filter")
		}
	}
	for _, scope := range ir.Scopes {
		goal := goals[scope.GoalID]
		if !claimID(scope.ID) || !validSpan(scope.IntentIRSpan) || !validateProjection(scope.IntentIRSpan) || goal.ID == "" || goal.ClauseID != scope.ClauseID || clauses[scope.ClauseID].Role != "domain_goal" {
			return errors.New("typed intent scope is not bound to its source goal")
		}
		if scope.Kind == "depth" && fmt.Sprint(scope.Value) != "1" {
			return errors.New("typed intent scope expands beyond the registered depth")
		}
		if scope.Kind != "depth" && scope.Kind != "window" && scope.Kind != "filter" {
			return errors.New("typed intent scope kind is unsupported")
		}
	}
	for _, constraint := range ir.Constraints {
		if !claimID(constraint.ID) || !validSpan(constraint.IntentIRSpan) || !validateProjection(constraint.IntentIRSpan) || clauses[constraint.ClauseID].Role != "safety_constraint" || constraint.Effect != "forbid" {
			return errors.New("typed intent safety constraint is invalid")
		}
	}
	for _, requirement := range ir.EvidenceRequirements {
		if !claimID(requirement.ID) || !validSpan(requirement.IntentIRSpan) || !validateProjection(requirement.IntentIRSpan) || clauses[requirement.ClauseID].Role != "evidence_requirement" || len(requirement.GoalIDs) == 0 || !allIntentGoalsExist(requirement.GoalIDs, goals) {
			return errors.New("typed intent evidence requirement is invalid")
		}
		if requirement.Kind != "real_callback_per_goal" && requirement.Kind != "independent_verification" {
			return errors.New("typed intent evidence requirement kind is unsupported")
		}
		if requirement.Kind == "real_callback_per_goal" && !coversEveryRequiredIntentGoal(requirement.GoalIDs, goals) {
			return errors.New("typed intent per-goal evidence policy is incomplete")
		}
	}
	for _, requirement := range ir.ResponseRequirements {
		if !claimID(requirement.ID) || !validSpan(requirement.IntentIRSpan) || !validateProjection(requirement.IntentIRSpan) || clauses[requirement.ClauseID].Role != "response_requirement" || len(requirement.GoalIDs) == 0 || !allIntentGoalsExist(requirement.GoalIDs, goals) {
			return errors.New("typed intent response requirement is invalid")
		}
		if requirement.Kind != "cover_all" && requirement.Kind != "synthesis" && requirement.Kind != "source_order" {
			return errors.New("typed intent response requirement kind is unsupported")
		}
		if (requirement.Kind == "cover_all" || requirement.Kind == "synthesis") && !coversEveryRequiredIntentGoal(requirement.GoalIDs, goals) {
			return errors.New("typed intent complete response policy is incomplete")
		}
	}
	for _, unknown := range ir.UnknownGoals {
		if !claimID(unknown.ID) || !validSpan(unknown.IntentIRSpan) || !validateProjection(unknown.IntentIRSpan) || clauses[unknown.ClauseID].Role != "unknown_business_goal" {
			return errors.New("typed intent unknown goal is invalid")
		}
	}
	for _, predicate := range ir.Predicates {
		if !claimID(predicate.ID) || !validSpan(predicate.IntentIRSpan) || !validateProjection(predicate.IntentIRSpan) || clauses[predicate.ClauseID].Role != "domain_goal" {
			return errors.New("typed intent predicate source binding is invalid")
		}
		if predicate.Kind == "quantifier" {
			collection := goals[predicate.CollectionGoalID]
			if collection.ResultKind != "collection" || predicate.Filter == nil || collection.ItemSchema[predicate.Filter.Field] != "string" || (predicate.Quantifier != "all" && predicate.Quantifier != "any") {
				return errors.New("typed intent quantifier is not bound to a typed collection")
			}
			lower := strings.ToLower(predicate.SourceText)
			if (strings.Contains(lower, " all ") || strings.Contains(lower, " every ") || strings.Contains(lower, "全部") || strings.Contains(lower, "所有")) && predicate.Quantifier != "all" {
				return errors.New("typed intent quantifier differs from source")
			}
			if (strings.Contains(lower, " any ") || strings.Contains(lower, "任一") || strings.Contains(lower, "任意")) && predicate.Quantifier != "any" {
				return errors.New("typed intent quantifier differs from source")
			}
		} else if predicate.Kind == "binary" {
			if predicate.Left == nil || predicate.Right == nil || !validSpan(predicate.Left.IntentIRSpan) || !validSpan(predicate.Right.IntentIRSpan) || !validateProjection(predicate.Left.IntentIRSpan) || !validateProjection(predicate.Right.IntentIRSpan) || predicate.Left.SourceStart >= predicate.Right.SourceStart || predicate.Left.SourceStart < predicate.SourceStart || predicate.Right.SourceEnd > predicate.SourceEnd {
				return errors.New("typed intent binary operand order or span is invalid")
			}
			left, right := goals[predicate.Left.GoalID], goals[predicate.Right.GoalID]
			if (predicate.Left.GoalID != "" && left.ID == "") || (predicate.Right.GoalID != "" && right.ID == "") || (left.ID != "" && right.ID != "" && (left.Domain != right.Domain || left.Entity != right.Entity)) {
				return errors.New("typed intent binary predicate crosses an unrelated domain")
			}
			switch predicate.Operator {
			case "equals", "not_equals", "lt", "lte", "gt", "gte":
			default:
				return errors.New("typed intent comparison operator is unsupported")
			}
			between := string(runes[predicate.Left.SourceEnd:predicate.Right.SourceStart])
			explicit := ""
			for _, token := range []string{"<=", ">=", "!=", "==", "<", ">"} {
				if strings.Contains(between, token) {
					explicit = token
					break
				}
			}
			expected := map[string]string{"<": "lt", "<=": "lte", ">": "gt", ">=": "gte", "==": "equals", "!=": "not_equals"}[explicit]
			if expected != "" && predicate.Operator != expected {
				return errors.New("typed intent comparison operator differs from source")
			}
		} else {
			return errors.New("typed intent predicate kind is unsupported")
		}
	}
	if err := validateConservativeIntentConstraints(*ir); err != nil {
		return err
	}
	return validateIntentPlanProjection(plan, *ir)
}

func validateConservativeIntentConstraints(ir protocol.ValidatedIntentIR) error {
	for _, clause := range ir.Clauses {
		if clause.Role != "safety_constraint" || clause.Polarity != "negative" {
			continue
		}
		text := strings.ToLower(clause.SourceText)
		actions := map[string][]string{
			"download": {"download", "fetch", "下载", "拉取"}, "install": {"install", "deploy", "安装", "部署"},
			"restart": {"restart", "reboot", "重启"}, "start": {" start ", "启动", "开服"}, "stop": {" stop ", "shutdown", "停止", "关服"},
			"write": {"write", "alter", "change", "modify", "edit", "setting", "config", "写入", "修改", "更改", "改", "配置"},
		}
		for action, tokens := range actions {
			matched := false
			for _, token := range tokens {
				if strings.Contains(" "+text+" ", token) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
			found := false
			for _, constraint := range ir.Constraints {
				if constraint.ClauseID == clause.ID && constraint.Action == action && constraint.SourceStart == clause.SourceStart && constraint.SourceEnd == clause.SourceEnd {
					found = true
					break
				}
			}
			if !found {
				return fmt.Errorf("typed intent omitted conservative %s constraint", action)
			}
		}
	}
	return nil
}

func hasCollectionDependency(goal protocol.IntentIRGoal, goals map[string]protocol.IntentIRGoal) bool {
	for _, id := range goal.DependsOn {
		if goals[id].ResultKind == "collection" {
			return true
		}
	}
	return false
}

func allIntentGoalsExist(ids []string, goals map[string]protocol.IntentIRGoal) bool {
	for _, id := range ids {
		if goals[id].ID == "" {
			return false
		}
	}
	return true
}

func coversEveryRequiredIntentGoal(ids []string, goals map[string]protocol.IntentIRGoal) bool {
	covered := map[string]bool{}
	for _, id := range ids {
		covered[id] = true
	}
	for id, goal := range goals {
		if goal.Required && !covered[id] {
			return false
		}
	}
	return true
}

func validateIntentPlanProjection(plan protocol.TaskPlan, ir protocol.ValidatedIntentIR) error {
	constraints := map[string]bool{}
	for _, value := range plan.Constraints {
		constraints[fmt.Sprintf("%s|%s|%d|%d", value.ClauseID, value.Action, value.SourceStart, value.SourceEnd)] = true
	}
	for _, value := range ir.Constraints {
		if !constraints[fmt.Sprintf("%s|%s|%d|%d", value.ClauseID, value.Action, value.SourceStart, value.SourceEnd)] {
			return errors.New("typed intent constraint was removed during plan compilation")
		}
	}
	sourceGoals := map[string]protocol.SourceGoal{}
	for _, value := range plan.SourceGoals {
		sourceGoals[value.ID] = value
	}
	atoms := map[string]protocol.SourceAtom{}
	for _, value := range plan.SourceAtoms {
		atoms[value.ID] = value
	}
	if len(plan.SourceGoals) != len(ir.Goals)+len(ir.Predicates) || len(plan.SourceAtoms) != len(ir.Goals)+len(ir.Predicates) {
		return errors.New("typed intent goals or predicates were added or removed during projection")
	}
	for _, value := range ir.Goals {
		projected := sourceGoals["sg-"+value.ID]
		atom := atoms["atom-"+value.ID]
		if projected.ID == "" || atom.ID == "" || projected.Domain != value.Domain || projected.Entity != value.Entity || projected.ResultKind != value.ResultKind || projected.Normalized != value.Capability || projected.SourceText != value.SourceText || projected.SourceStart != value.SourceStart || projected.SourceEnd != value.SourceEnd || len(atom.SourceGoalIDs) != 1 || atom.SourceGoalIDs[0] != projected.ID {
			return errors.New("typed intent goal changed during plan compilation")
		}
		capability := intentCapabilities[value.Capability]
		if capability.tool != "" {
			var requirement protocol.GoalRequirement
			for _, candidate := range plan.GoalRequirements {
				if containsString(candidate.SourceGoalIDs, projected.ID) {
					requirement = candidate
					break
				}
			}
			if len(requirement.ExecuteStepIDs) == 0 {
				return errors.New("typed intent capability lacks an executable bound step")
			}
			var step protocol.TaskStep
			for _, candidate := range plan.Steps {
				if candidate.ID == requirement.ExecuteStepIDs[0] {
					step = candidate
					break
				}
			}
			if step.Tool != capability.tool {
				return errors.New("typed intent capability was compiled to a different tool")
			}
			for key, expected := range value.Parameters {
				if !sameJSON(step.Args[key], expected) {
					return errors.New("typed intent parameter changed during step compilation")
				}
			}
		}
	}
	for _, value := range ir.Predicates {
		if sourceGoals["sg-"+value.ID].ID == "" || atoms["atom-"+value.ID].ID == "" {
			return errors.New("typed intent predicate was not projected exactly once")
		}
	}
	return nil
}

func validateSourceGoalBindings(plan protocol.TaskPlan) error {
	if len(plan.SourceAtoms) == 0 || plan.SourceAtomDigest == "" || len(plan.SourceGoals) == 0 || plan.SourceGoalDigest == "" {
		return errors.New("task plan omitted authoritative source goals or digest")
	}
	if plan.SourceAtomDigest != sourceAtomDigest(plan.Intent, plan.SourceAtoms) || plan.SourceGoalDigest != sourceGoalLedgerDigest(plan.Intent, plan.SourceAtoms, plan.SourceGoals) {
		return errors.New("source goal digest does not match intent and normalized goals")
	}
	intentRunes := []rune(plan.Intent)
	sources := map[string]protocol.SourceGoal{}
	atomMappings := map[string]int{}
	for _, atom := range plan.SourceAtoms {
		if atom.ID == "" || atom.SourceStart < 0 || atom.SourceEnd <= atom.SourceStart || atom.SourceEnd > len(intentRunes) || string(intentRunes[atom.SourceStart:atom.SourceEnd]) != atom.SourceText {
			return errors.New("source atom span does not bind the original intent")
		}
		if atom.Status != "mapped" && atom.Status != "unmapped" && atom.Status != "clarify" {
			return errors.New("source atom has an unknown mapping status")
		}
		if atom.Required && atom.Polarity == "positive" && (atom.Status != "mapped" || len(atom.SourceGoalIDs) != 1) {
			return errors.New("required positive source atom is not mapped exactly once")
		}
		for _, sourceID := range atom.SourceGoalIDs {
			atomMappings[sourceID]++
		}
	}
	collectionIdentities := map[string]bool{}
	judgementSpans := map[string]bool{}
	for _, source := range plan.SourceGoals {
		if source.ID == "" || sources[source.ID].ID != "" {
			return errors.New("source goal id is missing or duplicated")
		}
		if source.SourceStart < 0 || source.SourceEnd <= source.SourceStart || source.SourceEnd > len(intentRunes) || string(intentRunes[source.SourceStart:source.SourceEnd]) != source.SourceText {
			return errors.New("source goal span does not bind the original intent")
		}
		if !validResultKind(source.ResultKind) {
			return errors.New("source goal contains an unknown result shape")
		}
		if source.Status != "mapped" && source.Status != "unmapped" {
			return errors.New("source goal contains an unknown mapping status")
		}
		if source.ResultKind == "filtered_count" && (source.Filter == nil || source.Filter.Field == "" || source.Filter.Value == "") {
			return errors.New("filtered count source goal omitted its deterministic filter")
		}
		if source.ResultKind == "collection" {
			identity := canonicalCollectionIdentity(source)
			if collectionIdentities[identity] {
				return errors.New("the same canonical collection appears more than once")
			}
			collectionIdentities[identity] = true
		}
		if source.ResultKind == "judgement" {
			span := fmt.Sprintf("%d:%d", source.SourceStart, source.SourceEnd)
			if judgementSpans[span] {
				return errors.New("two judgements reuse the same source span")
			}
			judgementSpans[span] = true
			if !isResourcePressureSource(source) && (source.Predicate == nil || (source.Predicate.SchemaVersion != "goal-predicate/v1" && source.Predicate.SchemaVersion != "goal-predicate/v2") || !validPredicateOperator(source.Predicate.Operator)) {
				return errors.New("judgement source goal omitted a valid auditable predicate")
			}
		}
		sources[source.ID] = source
	}
	for _, source := range plan.SourceGoals {
		if source.Required && atomMappings[source.ID] != 1 {
			return errors.New("required source goal lacks an exact reverse atom mapping")
		}
		for _, dependency := range source.DependsOn {
			if sources[dependency].ID == "" || dependency == source.ID {
				return errors.New("derived source goal references an absent dependency")
			}
		}
		if source.ResultKind == "judgement" {
			if isResourcePressureSource(source) {
				if err := validateResourcePressureSource(source, sources); err != nil {
					return err
				}
			} else if err := validateTypedPredicate(source.Predicate, source, sources); err != nil {
				return err
			}
		}
	}
	mapped := map[string]string{}
	for _, goal := range plan.GoalRequirements {
		if goal.Supporting {
			if goal.Required || goal.SupportReason == "" || len(goal.SupportsSourceGoalIDs) == 0 || len(goal.SourceGoalIDs) != 1 {
				return errors.New("supporting goal does not trace to an original source goal")
			}
			own, ok := sources[goal.SourceGoalIDs[0]]
			if !ok || own.Required || goal.Domain != own.Domain || goal.Target != own.Entity {
				return errors.New("supporting goal expands scope or has no optional source dependency")
			}
			for _, sourceID := range goal.SupportsSourceGoalIDs {
				supported, ok := sources[sourceID]
				if !ok || !supported.Required || supported.Domain != own.Domain || supported.Entity != own.Entity || !containsString(supported.DependsOn, own.ID) {
					return errors.New("supporting goal expands scope or is not a required dependency")
				}
			}
		} else if len(goal.SourceGoalIDs) == 0 {
			return errors.New("non-supporting goal is not bound to an original source goal")
		}
		for _, sourceID := range goal.SourceGoalIDs {
			source, ok := sources[sourceID]
			if !ok {
				return errors.New("goal references an unknown source goal")
			}
			if goal.ResultKind != source.ResultKind || goal.Domain != source.Domain || goal.Target != source.Entity {
				return errors.New("goal result shape, domain, or target does not match its source goal")
			}
			mapped[sourceID] = goal.ID
		}
	}
	for _, source := range plan.SourceGoals {
		if source.Required && (source.Status == "unmapped" || mapped[source.ID] == "") {
			return errors.New("required source goal is not covered by a bound goal")
		}
		if len(source.DependsOn) > 0 {
			goalID := mapped[source.ID]
			var requirement *protocol.GoalRequirement
			for index := range plan.GoalRequirements {
				if plan.GoalRequirements[index].ID == goalID {
					requirement = &plan.GoalRequirements[index]
					break
				}
			}
			if requirement == nil {
				return errors.New("derived goal requirement is absent")
			}
			expected := map[string]bool{}
			for _, dependency := range source.DependsOn {
				expected[mapped[dependency]] = true
			}
			if len(requirement.DependsOnGoalIDs) != len(expected) {
				return errors.New("derived goal dependencies are incomplete")
			}
			for _, dependency := range requirement.DependsOnGoalIDs {
				if !expected[dependency] {
					return errors.New("derived goal dependency binding drifted")
				}
			}
			if source.ResultKind == "judgement" && !isResourcePressureSource(source) && !predicateEquivalent(source.Predicate, requirement.Predicate, mapped) {
				return errors.New("derived goal predicate binding drifted")
			}
			if isResourcePressureSource(source) && requirement.Predicate != nil {
				return errors.New("resource pressure goal introduced an untrusted predicate")
			}
		}
	}
	return nil
}

func isResourcePressureSource(source protocol.SourceGoal) bool {
	return source.Normalized == "performance.pressure"
}

func validateResourcePressureSource(source protocol.SourceGoal, sources map[string]protocol.SourceGoal) error {
	if source.Domain != "performance" || source.Entity != "resource-pressure" || source.ResultKind != "judgement" || source.Predicate != nil || len(source.DependsOn) != 2 || source.DependsOn[0] == source.DependsOn[1] {
		return errors.New("resource pressure judgement shape is invalid")
	}
	found := map[string]bool{}
	for _, dependencyID := range source.DependsOn {
		dependency, ok := sources[dependencyID]
		if !ok || !dependency.Required || dependency.Status != "mapped" || dependency.Domain != "performance" || dependency.ResultKind != "fact" {
			return errors.New("resource pressure dependencies are absent or incompatible")
		}
		found[dependency.Normalized] = true
	}
	if len(found) != 2 || !found["performance.cpu"] || !found["performance.memory"] {
		return errors.New("resource pressure judgement dependencies drifted")
	}
	return nil
}

func validateClauseRoleLedger(plan protocol.TaskPlan) error {
	if len(plan.ClauseLedger) == 0 || plan.ClauseLedgerDigest == "" || plan.ClauseLedgerDigest != clauseLedgerDigest(plan.Intent, plan.ClauseLedger) {
		return errors.New("clause role ledger or digest is missing or inconsistent")
	}
	runes := []rune(plan.Intent)
	clauses := map[string]protocol.ClauseRoleEntry{}
	for _, clause := range plan.ClauseLedger {
		if clause.ID == "" || clauses[clause.ID].ID != "" || clause.SourceStart < 0 || clause.SourceEnd <= clause.SourceStart || clause.SourceEnd > len(runes) || string(runes[clause.SourceStart:clause.SourceEnd]) != clause.SourceText {
			return errors.New("clause role span does not bind the original intent")
		}
		switch clause.Role {
		case "domain_goal":
			if clause.Polarity != "positive" || clause.Status != "mapped" || len(clause.SourceGoalIDs) == 0 || len(clause.SourceAtomIDs) == 0 {
				return errors.New("domain clause lacks positive goal and atom reverse mappings")
			}
		case "safety_constraint":
			if clause.Polarity != "negative" || len(clause.ConstraintActions) == 0 || len(clause.SourceGoalIDs) > 0 {
				return errors.New("safety clause has invalid polarity or business mapping")
			}
		case "evidence_requirement", "response_requirement", "discourse":
			if len(clause.SourceGoalIDs) > 0 || len(clause.SourceAtomIDs) > 0 {
				return errors.New("meta or discourse clause was promoted to a business goal")
			}
		case "unknown_business_goal":
			if clause.Status != "clarify" || clause.Polarity != "positive" {
				return errors.New("unknown business clause does not fail closed")
			}
		default:
			return errors.New("clause role is unsupported")
		}
		clauses[clause.ID] = clause
	}
	for _, id := range append(append([]string{}, plan.EvidencePolicy.ClauseIDs...), plan.ResponsePolicy.ClauseIDs...) {
		if clauses[id].ID == "" {
			return errors.New("meta policy references an unknown clause")
		}
	}
	for _, id := range plan.EvidencePolicy.ClauseIDs {
		if clauses[id].Role != "evidence_requirement" {
			return errors.New("evidence policy references a non-evidence clause")
		}
	}
	for _, id := range plan.ResponsePolicy.ClauseIDs {
		if clauses[id].Role != "response_requirement" {
			return errors.New("response policy references a non-response clause")
		}
	}
	for _, clause := range plan.ClauseLedger {
		if clause.Role != "safety_constraint" {
			continue
		}
		for _, action := range clause.ConstraintActions {
			found := false
			for _, constraint := range plan.Constraints {
				if constraint.ClauseID == clause.ID && constraint.Action == action && constraint.Effect == "forbid" && constraint.SourceStart == clause.SourceStart && constraint.SourceEnd == clause.SourceEnd && constraint.Source == clause.SourceText {
					found = true
					break
				}
			}
			if !found {
				return errors.New("safety clause action is not projected as an exact forbid constraint")
			}
		}
	}
	for _, atom := range plan.SourceAtoms {
		clause := clauses[atom.ClauseID]
		if clause.ID == "" || !containsString(clause.SourceAtomIDs, atom.ID) {
			return errors.New("source atom is not reverse-bound to its source clause")
		}
		for _, goalID := range atom.SourceGoalIDs {
			if !containsString(clause.SourceGoalIDs, goalID) {
				return errors.New("source goal is not reverse-bound to its source clause")
			}
		}
	}
	for _, constraint := range plan.Constraints {
		clause := clauses[constraint.ClauseID]
		if clause.Role != "safety_constraint" || constraint.Effect != "forbid" || clause.SourceStart != constraint.SourceStart || clause.SourceEnd != constraint.SourceEnd || constraint.SourceStart < 0 || constraint.SourceEnd > len(runes) || string(runes[constraint.SourceStart:constraint.SourceEnd]) != constraint.Source {
			return errors.New("constraint source span or clause binding is invalid")
		}
		if !containsString(clause.ConstraintActions, constraint.Action) {
			return errors.New("constraint action is not reverse-bound to its source clause")
		}
		for _, candidate := range plan.ClauseLedger {
			if candidate.Role == "domain_goal" && candidate.SourceStart < constraint.SourceEnd && candidate.SourceEnd > constraint.SourceStart {
				return errors.New("constraint scope overlaps a positive domain clause")
			}
		}
	}
	return nil
}

func predicateEquivalent(source, goal *protocol.GoalPredicate, mapped map[string]string) bool {
	if source == nil || goal == nil || source.SchemaVersion != goal.SchemaVersion || source.Operator != goal.Operator || source.Expected != goal.Expected || source.Quantifier != goal.Quantifier || !sameJSON(source.Filter, goal.Filter) || len(source.Operands) != len(goal.Operands) {
		return false
	}
	if !operandEquivalent(source.Left, goal.Left, mapped) || !operandEquivalent(source.Right, goal.Right, mapped) {
		return false
	}
	for index, sourceOperand := range source.Operands {
		goalOperand := goal.Operands[index]
		if sourceOperand.GoalID != "" && mapped[sourceOperand.GoalID] != goalOperand.GoalID {
			return false
		}
		if sourceOperand.Selector != goalOperand.Selector || sourceOperand.Domain != goalOperand.Domain || sourceOperand.Entity != goalOperand.Entity || sourceOperand.ResultKind != goalOperand.ResultKind || sourceOperand.SourceText != goalOperand.SourceText || sourceOperand.SourceStart != goalOperand.SourceStart || sourceOperand.SourceEnd != goalOperand.SourceEnd || sourceOperand.SourceRole != goalOperand.SourceRole || !sameJSON(sourceOperand.Filter, goalOperand.Filter) || !sameJSON(sourceOperand.Value, goalOperand.Value) {
			return false
		}
		if (sourceOperand.Predicate == nil) != (goalOperand.Predicate == nil) || sourceOperand.Predicate != nil && !predicateEquivalent(sourceOperand.Predicate, goalOperand.Predicate, mapped) {
			return false
		}
	}
	return true
}

func operandEquivalent(source, goal *protocol.GoalPredicateOperand, mapped map[string]string) bool {
	if (source == nil) != (goal == nil) {
		return false
	}
	if source == nil {
		return true
	}
	if source.GoalID != "" && mapped[source.GoalID] != goal.GoalID {
		return false
	}
	return source.Selector == goal.Selector && source.Domain == goal.Domain && source.Entity == goal.Entity && source.ResultKind == goal.ResultKind && source.SourceText == goal.SourceText && source.SourceStart == goal.SourceStart && source.SourceEnd == goal.SourceEnd && source.SourceRole == goal.SourceRole && sameJSON(source.Filter, goal.Filter) && sameJSON(source.Value, goal.Value)
}

func validResultKind(kind string) bool {
	switch kind {
	case "fact", "collection", "count", "filtered_count", "judgement":
		return true
	}
	return false
}

func sourceAtomDigest(intent string, atoms []protocol.SourceAtom) string {
	raw := canonicalDigestJSON(struct {
		Intent      string                `json:"intent"`
		SourceAtoms []protocol.SourceAtom `json:"source_atoms"`
	}{intent, atoms})
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func clauseLedgerDigest(intent string, clauses []protocol.ClauseRoleEntry) string {
	raw := canonicalDigestJSON(struct {
		Intent       string                     `json:"intent"`
		ClauseLedger []protocol.ClauseRoleEntry `json:"clause_ledger"`
	}{intent, clauses})
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func sourceGoalLedgerDigest(intent string, atoms []protocol.SourceAtom, goals []protocol.SourceGoal) string {
	type normalizedGoal struct {
		ID          string                     `json:"id"`
		SourceText  string                     `json:"source_text"`
		SourceStart int                        `json:"source_start"`
		SourceEnd   int                        `json:"source_end"`
		Normalized  string                     `json:"normalized"`
		Domain      string                     `json:"domain"`
		Entity      string                     `json:"entity"`
		ResultKind  string                     `json:"result_kind"`
		Filter      *protocol.SourceGoalFilter `json:"filter"`
		ItemSchema  map[string]string          `json:"item_schema"`
		Predicate   *protocol.GoalPredicate    `json:"predicate"`
		DependsOn   []string                   `json:"depends_on"`
		Required    bool                       `json:"required"`
		Status      string                     `json:"status"`
	}
	normalized := make([]normalizedGoal, 0, len(goals))
	for _, goal := range goals {
		normalized = append(normalized, normalizedGoal{goal.ID, goal.SourceText, goal.SourceStart, goal.SourceEnd, goal.Normalized, goal.Domain, goal.Entity, goal.ResultKind, goal.Filter, goal.ItemSchema, goal.Predicate, goal.DependsOn, goal.Required, goal.Status})
	}
	raw := canonicalDigestJSON(struct {
		Intent      string                `json:"intent"`
		SourceAtoms []protocol.SourceAtom `json:"source_atoms"`
		SourceGoals []normalizedGoal      `json:"source_goals"`
	}{intent, atoms, normalized})
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func canonicalDigestJSON(value any) []byte {
	raw, _ := json.Marshal(value)
	var generic any
	_ = json.Unmarshal(raw, &generic)
	canonical, _ := json.Marshal(generic)
	return canonical
}

// sourceGoalDigest remains for legacy v1 fixture parity. New v2 plans bind
// the atom ledger through sourceGoalLedgerDigest above.
func sourceGoalDigest(intent string, goals []protocol.SourceGoal) string {
	type normalizedGoal struct {
		ID          string                     `json:"id"`
		SourceText  string                     `json:"source_text"`
		SourceStart int                        `json:"source_start"`
		SourceEnd   int                        `json:"source_end"`
		Normalized  string                     `json:"normalized"`
		Domain      string                     `json:"domain"`
		Entity      string                     `json:"entity"`
		ResultKind  string                     `json:"result_kind"`
		Filter      *protocol.SourceGoalFilter `json:"filter"`
		ItemSchema  map[string]string          `json:"item_schema"`
		Predicate   *protocol.GoalPredicate    `json:"predicate"`
		DependsOn   []string                   `json:"depends_on"`
		Required    bool                       `json:"required"`
		Status      string                     `json:"status"`
	}
	normalized := make([]normalizedGoal, 0, len(goals))
	for _, goal := range goals {
		normalized = append(normalized, normalizedGoal{goal.ID, goal.SourceText, goal.SourceStart, goal.SourceEnd, goal.Normalized, goal.Domain, goal.Entity, goal.ResultKind, goal.Filter, goal.ItemSchema, goal.Predicate, goal.DependsOn, goal.Required, goal.Status})
	}
	raw, _ := json.Marshal(struct {
		Intent      string           `json:"intent"`
		SourceGoals []normalizedGoal `json:"source_goals"`
	}{intent, normalized})
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func validPredicateOperator(operator string) bool {
	switch operator {
	case "all_match", "any_match", "equals", "not_equals", "lt", "lte", "gt", "gte", "and", "or", "not":
		return true
	}
	return false
}

func validateTypedPredicate(predicate *protocol.GoalPredicate, owner protocol.SourceGoal, sources map[string]protocol.SourceGoal) error {
	if predicate == nil || (predicate.SchemaVersion != "goal-predicate/v1" && predicate.SchemaVersion != "goal-predicate/v2") || !validPredicateOperator(predicate.Operator) {
		return errors.New("judgement lacks a versioned typed predicate")
	}
	if predicate.SchemaVersion == "goal-predicate/v2" {
		if predicate.Left == nil || predicate.Right == nil || len(predicate.Operands) != 2 || !sameJSON(predicate.Operands[0], *predicate.Left) || !sameJSON(predicate.Operands[1], *predicate.Right) {
			return errors.New("directed predicate operands are missing or reordered")
		}
		if predicate.Quantifier == "any" && (predicate.Operator != "gt" || predicate.Left.Selector != "filtered_count" || fmt.Sprint(predicate.Right.Value) != "0") {
			return errors.New("any quantifier must mean filtered_count greater than zero")
		}
		if predicate.Quantifier == "all" && (predicate.Operator != "equals" || predicate.Left.Selector != "filtered_count" || predicate.Right.Selector != "count") {
			return errors.New("all quantifier must mean filtered_count equals total count")
		}
		if predicate.Quantifier != "" {
			collection, ok := sources[predicate.Left.GoalID]
			if !ok || collection.ResultKind != "collection" || predicate.Left.Filter == nil || predicate.Filter == nil || !sameJSON(predicate.Left.Filter, predicate.Filter) || collection.ItemSchema[predicate.Left.Filter.Field] != "string" {
				return errors.New("quantified predicate filter is not bound to a compatible collection field")
			}
		}
		ownerRunes := []rune(owner.SourceText)
		for _, operand := range []protocol.GoalPredicateOperand{*predicate.Left, *predicate.Right} {
			if operand.SourceText == "" || operand.SourceStart < owner.SourceStart || operand.SourceEnd > owner.SourceEnd || operand.SourceEnd <= operand.SourceStart || string(ownerRunes[operand.SourceStart-owner.SourceStart:operand.SourceEnd-owner.SourceStart]) != operand.SourceText {
				return errors.New("directed predicate operand span does not bind its source judgement")
			}
		}
		if predicate.Quantifier == "" && predicate.Left.SourceStart > predicate.Right.SourceStart {
			return errors.New("directed predicate operands were reordered from the original source")
		}
	}
	if predicate.Operator == "and" || predicate.Operator == "or" || predicate.Operator == "not" {
		if predicate.Operator == "not" && len(predicate.Operands) != 1 || predicate.Operator != "not" && len(predicate.Operands) < 2 {
			return errors.New("boolean predicate has invalid arity")
		}
		for _, operand := range predicate.Operands {
			if operand.Predicate == nil || operand.GoalID != "" {
				return errors.New("boolean predicate operands must be nested predicates")
			}
			if err := validateTypedPredicate(operand.Predicate, owner, sources); err != nil {
				return err
			}
		}
		return nil
	}
	if len(predicate.Operands) == 0 {
		return errors.New("predicate has no operands")
	}
	for _, operand := range predicate.Operands {
		if operand.GoalID == "" {
			continue
		}
		referenced, ok := sources[operand.GoalID]
		if !ok {
			return errors.New("predicate references an unknown source goal")
		}
		if operand.Domain != referenced.Domain || operand.Entity != referenced.Entity || operand.ResultKind != referenced.ResultKind {
			return errors.New("predicate operand type or domain binding drifted")
		}
		if owner.Domain != referenced.Domain || owner.Entity != referenced.Entity {
			return errors.New("predicate crosses an unrelated domain or entity")
		}
	}
	if predicate.Operator == "all_match" || predicate.Operator == "any_match" {
		if len(predicate.Operands) != 1 {
			return errors.New("collection predicate has invalid arity")
		}
		operand := predicate.Operands[0]
		collection, ok := sources[operand.GoalID]
		if !ok || collection.ResultKind != "collection" || operand.Filter == nil || collection.ItemSchema[operand.Filter.Field] != "string" {
			return errors.New("collection predicate lacks a compatible string field")
		}
	}
	if predicate.Operator == "lt" || predicate.Operator == "lte" || predicate.Operator == "gt" || predicate.Operator == "gte" || predicate.Operator == "equals" || predicate.Operator == "not_equals" {
		if len(predicate.Operands) != 2 {
			return errors.New("comparison predicate has invalid arity")
		}
		for _, operand := range predicate.Operands {
			if operand.GoalID == "" {
				continue
			}
			kind := sources[operand.GoalID].ResultKind
			if kind != "fact" && kind != "count" && kind != "filtered_count" && !(kind == "collection" && (operand.Selector == "count" || operand.Selector == "filtered_count")) {
				return errors.New("comparison predicate references an incompatible result")
			}
		}
	}
	return nil
}

func validatePlanConstraints(plan protocol.TaskPlan) error {
	forbidden := map[string]bool{}
	for _, constraint := range plan.Constraints {
		if constraint.Effect != "forbid" {
			return errors.New("unknown plan constraint effect")
		}
		forbidden[constraint.Action] = true
	}
	for _, step := range plan.Steps {
		for _, action := range constrainedActions(step) {
			if forbidden[action] {
				return fmt.Errorf("step %s violates forbidden %s constraint", step.ID, action)
			}
		}
	}
	return nil
}

func validateGoalBindings(plan protocol.TaskPlan) error {
	steps := map[string]protocol.TaskStep{}
	boundSteps := map[string]bool{}
	for _, step := range plan.Steps {
		steps[step.ID] = step
	}
	for _, goal := range plan.GoalRequirements {
		if !goal.Required && !goal.Supporting {
			continue
		}
		if goal.ID == "" || goal.Target == "" || len(goal.ExecuteStepIDs) == 0 || len(goal.Evidence) == 0 || goal.Status == "unsupported" {
			return errors.New("required goal is missing executable coverage or evidence")
		}
		for _, id := range goal.ExecuteStepIDs {
			boundSteps[id] = true
			step, ok := steps[id]
			if !ok || step.Purpose == "verify" {
				return errors.New("goal execute binding does not reference an execute step")
			}
		}
		for _, id := range goal.VerifyStepIDs {
			boundSteps[id] = true
			step, ok := steps[id]
			if !ok || step.Purpose != "verify" {
				return errors.New("goal verification binding does not reference a verify step")
			}
		}
		allowedEvidenceSteps := map[string]bool{"terminal": true, "acceptance": true}
		for _, id := range goal.ExecuteStepIDs {
			allowedEvidenceSteps[id] = true
		}
		for _, id := range goal.VerifyStepIDs {
			allowedEvidenceSteps[id] = true
		}
		for _, evidence := range goal.Evidence {
			if evidence.StepID == "" || !allowedEvidenceSteps[evidence.StepID] {
				return errors.New("goal evidence is not bound to one of its execute or verify steps")
			}
		}
	}
	for _, step := range plan.Steps {
		if !boundSteps[step.ID] {
			return errors.New("step is not traceable to a user or supporting goal")
		}
	}
	return nil
}

func constrainedActions(step protocol.TaskStep) []string {
	policy, err := policyForStep(step)
	if err != nil {
		return []string{"write"}
	}
	if !policy.mutates {
		return nil
	}
	return append([]string(nil), policy.forbiddenActions...)
}

func validateOperationBinding(plan protocol.TaskPlan) error {
	executeSteps := []protocol.TaskStep{}
	for _, step := range plan.Steps {
		if step.Purpose != "verify" {
			executeSteps = append(executeSteps, step)
		}
	}
	if len(executeSteps) == 0 {
		return errors.New("operation has no executable step")
	}
	primary := executeSteps[0]
	strict := plan.Operation.SchemaVersion == "operation-objective/v2"
	if strict {
		if plan.Operation.Digest == "" || plan.Operation.Digest != operationDigest(plan.Steps) {
			return errors.New("operation digest does not match normalized steps")
		}
	}
	if strict || len(plan.Operation.Parameters) > 0 {
		if plan.Operation.Target != stepTarget(primary) || !sameJSON(plan.Operation.Parameters, primary.Args) {
			return errors.New("operation target or parameters do not bind the primary execute step")
		}
	}
	if err := validateBoundRequirements(plan, plan.Operation.ExecutionEvidence, false, strict); err != nil {
		return err
	}
	if err := validateBoundRequirements(plan, plan.Operation.VerificationEvidence, true, strict); err != nil {
		return err
	}
	return nil
}

func validateBoundRequirements(plan protocol.TaskPlan, requirements []protocol.OperationEvidenceRequirement, verification, strict bool) error {
	for _, requirement := range requirements {
		if requirement.StepID == "terminal" && requirement.Tool == "terminal" {
			if !verification {
				return errors.New("terminal evidence cannot satisfy execution")
			}
			continue
		}
		if requirement.StepID == "acceptance" && requirement.Tool == "acceptance" {
			if !verification || len(plan.Acceptance) == 0 {
				return errors.New("acceptance evidence is not backed by acceptance rules")
			}
			continue
		}
		var step protocol.TaskStep
		index := -1
		if requirement.StepID != "" {
			for candidateIndex, candidate := range plan.Steps {
				if candidate.ID == requirement.StepID {
					step, index = candidate, candidateIndex
					break
				}
			}
		}
		if strict && index < 0 {
			return fmt.Errorf("evidence requirement %q is not bound to a real step", requirement.Kind)
		}
		if index >= 0 {
			isVerification := step.Purpose == "verify"
			policy, err := policyForStep(step)
			if err != nil {
				return err
			}
			producerVerification := verification && !isVerification && policy.producerVerified &&
				requirement.Kind == "verification."+policy.evidenceKind
			if isVerification != verification && !producerVerification {
				return errors.New("evidence requirement is bound to the wrong step role")
			}
			expectedKind := policy.evidenceKind
			if verification {
				expectedKind = "verification." + expectedKind
			}
			if requirement.Kind != expectedKind {
				return errors.New("evidence kind does not match its bound step")
			}
			if strict && (requirement.Tool != step.Tool || requirement.Order != index || !sameJSON(requirement.Parameters, step.Args)) {
				return errors.New("evidence tool, order, or parameters do not bind the normalized step")
			}
			target := stepTarget(step)
			if verification && isVerification {
				for previous := index - 1; previous >= 0; previous-- {
					if plan.Steps[previous].Purpose != "verify" {
						target = stepTarget(plan.Steps[previous])
						break
					}
				}
			}
			if strict && requirement.Target != target {
				return errors.New("evidence target does not bind the related execute step")
			}
		}
		if len(requirement.Contains) > 0 && (strict || strings.HasPrefix(requirement.Kind, "console") || strings.HasPrefix(requirement.Kind, "verification.logs")) {
			boundTarget := requirement.Target
			boundParameters := requirement.Parameters
			if !strict && boundTarget == "" {
				boundTarget = plan.Operation.Target
				boundParameters = plan.Operation.Parameters
			}
			bound, _ := json.Marshal(map[string]any{"target": boundTarget, "parameters": boundParameters, "expected": requirement.Expected})
			lower := strings.ToLower(string(bound))
			for _, token := range requirement.Contains {
				if !strings.Contains(lower, strings.ToLower(token)) {
					return fmt.Errorf("evidence token %q is unrelated to its bound target and parameters", token)
				}
			}
		}
	}
	return nil
}

func operationDigest(steps []protocol.TaskStep) string {
	normalized := make([]map[string]any, 0, len(steps))
	for index, step := range steps {
		purpose := step.Purpose
		if purpose == "" {
			purpose = "execute"
		}
		normalized = append(normalized, map[string]any{
			"id": step.ID, "tool": step.Tool, "target": stepTarget(step), "parameters": step.Args,
			"order": index, "purpose": purpose,
		})
	}
	raw, _ := json.Marshal(normalized)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func stepTarget(step protocol.TaskStep) string {
	for _, key := range generatedTargetKeys {
		if value, ok := step.Args[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return step.Tool
}

func sameJSON(left, right any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}

func verificationMatches(execution pendingExecution, verification protocol.TaskStep) bool {
	verificationPolicy, err := policyForStep(verification)
	if err == nil && !execution.policy.mutates && !verificationPolicy.mutates && execution.step.Tool == verification.Tool {
		return stepTarget(execution.step) == stepTarget(verification) && sameObservationArgs(execution.step.Args, verification.Args)
	}
	mode, ok := execution.policy.verification[verification.Tool]
	if !ok {
		return false
	}
	switch mode {
	case "same_path":
		return stringArgument(execution.step.Args, "path") != "" &&
			stringArgument(execution.step.Args, "path") == stringArgument(verification.Args, "path")
	case "plugins_directory":
		path := strings.Trim(stringArgument(verification.Args, "path"), "/")
		return verification.Tool == "files.list" && path == "plugins"
	case "any":
		return true
	case "whitelist_config":
		command := strings.ToLower(stringArgument(execution.step.Args, "command"))
		return strings.HasPrefix(command, "whitelist ") && stringArgument(verification.Args, "path") == "server.properties"
	case "console_readback":
		return consoleReadbackMatches(
			stringArgument(execution.step.Args, "command"),
			stringArgument(verification.Args, "command"),
		)
	}
	return false
}

func sameObservationArgs(left, right map[string]any) bool {
	clean := func(value map[string]any) map[string]any {
		result := map[string]any{}
		for key, item := range value {
			if key != "expect" {
				result[key] = item
			}
		}
		return result
	}
	return sameJSON(clean(left), clean(right))
}

func canonicalCollectionIdentity(source protocol.SourceGoal) string {
	entity := strings.TrimSuffix(source.Entity, "/")
	if entity == "" {
		entity = "/"
	}
	keys := make([]string, 0, len(source.ItemSchema))
	for key := range source.ItemSchema {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	schema := make([]string, 0, len(keys))
	for _, key := range keys {
		schema = append(schema, key+":"+source.ItemSchema[key])
	}
	return source.Domain + "\x00" + entity + "\x00" + strings.Join(schema, ",")
}

func consoleReadbackMatches(execute, verify string) bool {
	executeFields := strings.Fields(strings.ToLower(execute))
	verifyFields := strings.Fields(strings.ToLower(verify))
	if len(executeFields) == 0 || len(verifyFields) == 0 {
		return false
	}
	switch strings.TrimPrefix(executeFields[0], "minecraft:") {
	case "difficulty":
		return strings.Join(verifyFields, " ") == "difficulty"
	case "time":
		return len(verifyFields) == 3 && verifyFields[0] == "time" && verifyFields[1] == "query"
	case "gamerule":
		return len(executeFields) > 1 && len(verifyFields) == 2 && verifyFields[0] == "gamerule" && verifyFields[1] == executeFields[1]
	case "whitelist":
		return strings.Join(verifyFields, " ") == "whitelist list"
	case "gamemode":
		return len(executeFields) > 2 && len(verifyFields) == 5 && verifyFields[0] == "data" && verifyFields[1] == "get" && verifyFields[2] == "entity" && verifyFields[3] == executeFields[2] && verifyFields[4] == "playergametype"
	default:
		return false
	}
}

func stringArgument(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

func combineActions(current, next string) string {
	if actionRanks[next] > actionRanks[current] {
		return next
	}
	return current
}

func validateEvidenceKinds(requirements []protocol.OperationEvidenceRequirement, allowed map[string]bool, verification bool, hasAcceptance bool) error {
	for _, requirement := range requirements {
		kind := requirement.Kind
		if verification {
			if kind == "verification" && hasAcceptance {
				continue
			}
			if !strings.HasPrefix(kind, "verification.") || !allowed[kind] {
				return fmt.Errorf("verification evidence kind %q does not match a verification step", kind)
			}
		} else if strings.HasPrefix(kind, "verification.") || !allowed[kind] {
			return fmt.Errorf("execution evidence kind %q does not match an execute step", kind)
		}
	}
	return nil
}
