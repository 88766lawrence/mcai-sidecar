package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/mcai/sidecar-agent/internal/identity"
)

const SchemaVersion = "agent-message/v1"

type Envelope struct {
	SchemaVersion string          `json:"schema_version"`
	MessageID     string          `json:"message_id"`
	Timestamp     string          `json:"timestamp"`
	Nonce         string          `json:"nonce"`
	TenantID      string          `json:"tenant_id"`
	AgentID       string          `json:"agent_id"`
	Type          string          `json:"type"`
	Payload       json.RawMessage `json:"payload"`
	Signature     string          `json:"signature,omitempty"`
}

type TaskPlan struct {
	SchemaVersion      string              `json:"schema_version"`
	ExecutionMode     string              `json:"execution_mode,omitempty"`
	AgentExecution    *AgentToolExecution `json:"agent_execution,omitempty"`
	PolicyVersion      string              `json:"policy_version"`
	PolicyDigest       string              `json:"policy_digest"`
	TaskID             string              `json:"task_id"`
	InstanceRef        string              `json:"instance_ref"`
	Intent             string              `json:"intent"`
	IntentIR           *ValidatedIntentIR  `json:"intent_ir,omitempty"`
	IntentIRDigest     string              `json:"intent_ir_digest,omitempty"`
	InventoryRevision  string              `json:"inventory_revision"`
	Operation          OperationObjective  `json:"operation"`
	ClauseLedger       []ClauseRoleEntry   `json:"clause_ledger"`
	ClauseLedgerDigest string              `json:"clause_ledger_digest"`
	EvidencePolicy     EvidencePolicy      `json:"evidence_policy"`
	ResponsePolicy     ResponsePolicy      `json:"response_policy"`
	SourceAtoms        []SourceAtom        `json:"source_atoms"`
	SourceAtomDigest   string              `json:"source_atom_digest"`
	SourceGoals        []SourceGoal        `json:"source_goals"`
	SourceGoalDigest   string              `json:"source_goal_digest"`
	GoalRequirements   []GoalRequirement   `json:"goal_requirements"`
	Constraints        []PlanConstraint    `json:"constraints"`
	Coverage           string              `json:"coverage"`
	Steps              []TaskStep          `json:"steps"`
	Acceptance         []AcceptanceRule    `json:"acceptance"`
	ConfirmedOperation *ConfirmedOperation `json:"confirmed_operation,omitempty"`
}

type AgentToolExecution struct {
	SchemaVersion     string         `json:"schema_version"`
	ToolCallID        string         `json:"tool_call_id"`
	Tool              string         `json:"tool"`
	Arguments         map[string]any `json:"arguments"`
	InstanceRef       string         `json:"instance_ref"`
	InventoryRevision string         `json:"inventory_revision"`
	PolicyVersion     string         `json:"policy_version"`
	PolicyDigest      string         `json:"policy_digest"`
	OperationDigest   string         `json:"operation_digest"`
}

type ConfirmedOperationStep struct {
	ID                   string         `json:"id"`
	Tool                 string         `json:"tool"`
	Target               string         `json:"target"`
	Parameters           map[string]any `json:"parameters"`
	Order                int            `json:"order"`
	Purpose              string         `json:"purpose"`
	Risk                 string         `json:"risk"`
	RequiresConfirmation bool           `json:"requires_confirmation"`
}

type ConfirmedOperation struct {
	SchemaVersion        string                   `json:"schema_version"`
	InstanceRef          string                   `json:"instance_ref"`
	OperationDigest      string                   `json:"operation_digest"`
	Risk                 string                   `json:"risk"`
	RequiresConfirmation bool                     `json:"requires_confirmation"`
	Steps                []ConfirmedOperationStep `json:"steps"`
	ScopeDigest          string                   `json:"scope_digest"`
	SummaryDigest        string                   `json:"summary_digest"`
	ConfirmedAt          string                   `json:"confirmed_at"`
	ExpiresAt            string                   `json:"expires_at"`
}

type IntentIRSpan struct {
	SourceText   string   `json:"source_text"`
	SourceStart  int      `json:"source_start"`
	SourceEnd    int      `json:"source_end"`
	SourceRefIDs []string `json:"source_ref_ids,omitempty"`
}

type IntentSourceRef struct {
	ID          string `json:"id"`
	SourceStart int    `json:"source_start"`
	SourceEnd   int    `json:"source_end"`
	Text        string `json:"text"`
	Order       int    `json:"order"`
}

type IntentSourceCatalog struct {
	SchemaVersion string            `json:"schema_version"`
	SourceDigest  string            `json:"source_digest"`
	Refs          []IntentSourceRef `json:"refs"`
	Digest        string            `json:"digest"`
}

type IntentIRClause struct {
	IntentIRSpan
	ID       string `json:"id"`
	Role     string `json:"role"`
	Polarity string `json:"polarity"`
	Status   string `json:"status"`
	Reason   string `json:"reason"`
}

type IntentIRGoal struct {
	IntentIRSpan
	ID         string            `json:"id"`
	ClauseID   string            `json:"clause_id"`
	Domain     string            `json:"domain"`
	Entity     string            `json:"entity"`
	Capability string            `json:"capability"`
	Target     string            `json:"target"`
	Parameters map[string]any    `json:"parameters"`
	ResultKind string            `json:"result_kind"`
	Filter     *SourceGoalFilter `json:"filter,omitempty"`
	ItemSchema map[string]string `json:"item_schema,omitempty"`
	DependsOn  []string          `json:"depends_on,omitempty"`
	Required   bool              `json:"required"`
}

type IntentIRScope struct {
	IntentIRSpan
	ID       string `json:"id"`
	ClauseID string `json:"clause_id"`
	GoalID   string `json:"goal_id"`
	Kind     string `json:"kind"`
	Value    any    `json:"value"`
}

type IntentIRConstraint struct {
	IntentIRSpan
	ID       string `json:"id"`
	ClauseID string `json:"clause_id"`
	Action   string `json:"action"`
	Effect   string `json:"effect"`
}

type IntentIREvidenceRequirement struct {
	IntentIRSpan
	ID       string   `json:"id"`
	ClauseID string   `json:"clause_id"`
	Kind     string   `json:"kind"`
	GoalIDs  []string `json:"goal_ids"`
}

type IntentIRResponseRequirement struct {
	IntentIRSpan
	ID       string   `json:"id"`
	ClauseID string   `json:"clause_id"`
	Kind     string   `json:"kind"`
	GoalIDs  []string `json:"goal_ids"`
}

type IntentIROperand struct {
	IntentIRSpan
	GoalID   string `json:"goal_id,omitempty"`
	Selector string `json:"selector,omitempty"`
	Value    any    `json:"value,omitempty"`
}

type IntentIRPredicate struct {
	IntentIRSpan
	ID               string            `json:"id"`
	ClauseID         string            `json:"clause_id"`
	Kind             string            `json:"kind"`
	Expected         bool              `json:"expected"`
	Quantifier       string            `json:"quantifier,omitempty"`
	CollectionGoalID string            `json:"collection_goal_id,omitempty"`
	Filter           *SourceGoalFilter `json:"filter,omitempty"`
	Operator         string            `json:"operator,omitempty"`
	Left             *IntentIROperand  `json:"left,omitempty"`
	Right            *IntentIROperand  `json:"right,omitempty"`
}

type IntentIRUnknownGoal struct {
	IntentIRSpan
	ID       string `json:"id"`
	ClauseID string `json:"clause_id"`
	Reason   string `json:"reason"`
}

type IntentIRCompiler struct {
	ProviderModel          string `json:"provider_model"`
	Attempt                int    `json:"attempt"`
	DeterministicValidator string `json:"deterministic_validator"`
}

type ValidatedIntentIR struct {
	SchemaVersion        string                        `json:"schema_version"`
	Clauses              []IntentIRClause              `json:"clauses"`
	Goals                []IntentIRGoal                `json:"goals"`
	Scopes               []IntentIRScope               `json:"scopes"`
	Constraints          []IntentIRConstraint          `json:"constraints"`
	EvidenceRequirements []IntentIREvidenceRequirement `json:"evidence_requirements"`
	ResponseRequirements []IntentIRResponseRequirement `json:"response_requirements"`
	Predicates           []IntentIRPredicate           `json:"predicates"`
	UnknownGoals         []IntentIRUnknownGoal         `json:"unknown_goals"`
	SourceCatalog        *IntentSourceCatalog          `json:"source_catalog,omitempty"`
	Source               string                        `json:"source"`
	Digest               string                        `json:"digest"`
	Compiler             IntentIRCompiler              `json:"compiler"`
}

type SourceAtom struct {
	ID            string   `json:"id"`
	SourceText    string   `json:"source_text"`
	SourceStart   int      `json:"source_start"`
	SourceEnd     int      `json:"source_end"`
	Polarity      string   `json:"polarity"`
	Role          string   `json:"role"`
	Normalized    string   `json:"normalized"`
	Required      bool     `json:"required"`
	Status        string   `json:"status"`
	SourceGoalIDs []string `json:"source_goal_ids"`
	Reason        string   `json:"reason"`
	ClauseID      string   `json:"clause_id"`
}

type ClauseRoleEntry struct {
	ID                string   `json:"id"`
	SourceText        string   `json:"source_text"`
	SourceStart       int      `json:"source_start"`
	SourceEnd         int      `json:"source_end"`
	Role              string   `json:"role"`
	Polarity          string   `json:"polarity"`
	Status            string   `json:"status"`
	Reason            string   `json:"reason"`
	SourceAtomIDs     []string `json:"source_atom_ids"`
	SourceGoalIDs     []string `json:"source_goal_ids"`
	ConstraintActions []string `json:"constraint_actions"`
}

type EvidencePolicy struct {
	RequireRealCallbackPerGoal     bool     `json:"require_real_callback_per_goal"`
	RequireIndependentVerification bool     `json:"require_independent_verification"`
	ClauseIDs                      []string `json:"clause_ids"`
}

type ResponsePolicy struct {
	CoverAllRequiredGoals bool     `json:"cover_all_required_goals"`
	RequireSynthesis      bool     `json:"require_synthesis"`
	ClauseIDs             []string `json:"clause_ids"`
}

type SourceGoalFilter struct {
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

type SourceGoal struct {
	ID          string            `json:"id"`
	SourceText  string            `json:"source_text"`
	SourceStart int               `json:"source_start"`
	SourceEnd   int               `json:"source_end"`
	Normalized  string            `json:"normalized"`
	Domain      string            `json:"domain"`
	Entity      string            `json:"entity"`
	ResultKind  string            `json:"result_kind"`
	Filter      *SourceGoalFilter `json:"filter,omitempty"`
	ItemSchema  map[string]string `json:"item_schema,omitempty"`
	Predicate   *GoalPredicate    `json:"predicate,omitempty"`
	DependsOn   []string          `json:"depends_on"`
	Required    bool              `json:"required"`
	Status      string            `json:"status"`
}

type GoalRequirement struct {
	ID                    string                         `json:"id"`
	Description           string                         `json:"description"`
	Domain                string                         `json:"domain"`
	Action                string                         `json:"action"`
	Target                string                         `json:"target"`
	Required              bool                           `json:"required"`
	SourceGoalIDs         []string                       `json:"source_goal_ids"`
	ResultKind            string                         `json:"result_kind"`
	Filter                *SourceGoalFilter              `json:"filter,omitempty"`
	Predicate             *GoalPredicate                 `json:"predicate,omitempty"`
	DependsOnGoalIDs      []string                       `json:"depends_on_goal_ids,omitempty"`
	ExecuteStepIDs        []string                       `json:"execute_step_ids"`
	VerifyStepIDs         []string                       `json:"verify_step_ids"`
	Evidence              []OperationEvidenceRequirement `json:"evidence"`
	Status                string                         `json:"status,omitempty"`
	Supporting            bool                           `json:"supporting,omitempty"`
	SupportsSourceGoalIDs []string                       `json:"supports_source_goal_ids,omitempty"`
	SupportReason         string                         `json:"support_reason,omitempty"`
}

type GoalPredicateOperand struct {
	GoalID      string            `json:"goal_id,omitempty"`
	Selector    string            `json:"selector,omitempty"`
	Filter      *SourceGoalFilter `json:"filter,omitempty"`
	Value       any               `json:"value,omitempty"`
	Predicate   *GoalPredicate    `json:"predicate,omitempty"`
	Domain      string            `json:"domain,omitempty"`
	Entity      string            `json:"entity,omitempty"`
	ResultKind  string            `json:"result_kind,omitempty"`
	SourceText  string            `json:"source_text,omitempty"`
	SourceStart int               `json:"source_start,omitempty"`
	SourceEnd   int               `json:"source_end,omitempty"`
	SourceRole  string            `json:"source_role,omitempty"`
}

type GoalPredicate struct {
	SchemaVersion string                 `json:"schema_version"`
	Operator      string                 `json:"operator"`
	Operands      []GoalPredicateOperand `json:"operands"`
	Left          *GoalPredicateOperand  `json:"left,omitempty"`
	Right         *GoalPredicateOperand  `json:"right,omitempty"`
	Quantifier    string                 `json:"quantifier,omitempty"`
	Filter        *SourceGoalFilter      `json:"filter,omitempty"`
	Expected      bool                   `json:"expected"`
}

type PlanConstraint struct {
	Action      string `json:"action"`
	Effect      string `json:"effect"`
	Source      string `json:"source"`
	SourceStart int    `json:"source_start"`
	SourceEnd   int    `json:"source_end"`
	ClauseID    string `json:"clause_id"`
}

type OperationObjective struct {
	SchemaVersion        string                         `json:"schema_version"`
	Digest               string                         `json:"digest,omitempty"`
	Capability           string                         `json:"capability"`
	Action               string                         `json:"action"`
	Target               string                         `json:"target"`
	Parameters           map[string]any                 `json:"parameters"`
	Risk                 string                         `json:"risk"`
	RequiresConfirmation bool                           `json:"requires_confirmation"`
	ExecutionEvidence    []OperationEvidenceRequirement `json:"execution_evidence"`
	VerificationEvidence []OperationEvidenceRequirement `json:"verification_evidence"`
	Recovery             string                         `json:"recovery"`
}

type OperationEvidenceRequirement struct {
	Kind       string         `json:"kind"`
	StepID     string         `json:"step_id,omitempty"`
	Tool       string         `json:"tool,omitempty"`
	Target     string         `json:"target,omitempty"`
	Parameters map[string]any `json:"parameters,omitempty"`
	Order      int            `json:"order,omitempty"`
	Expected   any            `json:"expected,omitempty"`
	Contains   []string       `json:"contains,omitempty"`
}

type TaskStep struct {
	ID                   string         `json:"id"`
	Tool                 string         `json:"tool"`
	Args                 map[string]any `json:"args"`
	Risk                 string         `json:"risk"`
	Purpose              string         `json:"purpose,omitempty"`
	RequiresConfirmation bool           `json:"requires_confirmation"`
}
type AcceptanceRule struct {
	Type     string `json:"type"`
	Expected string `json:"expected,omitempty"`
	Pattern  string `json:"pattern,omitempty"`
	Name     string `json:"name,omitempty"`
}

func NewEnvelope(id *identity.Identity, tenantID, messageID, nonce, messageType string, payload any) (Envelope, error) {
	raw, err := marshalPayload(payload)
	if err != nil {
		return Envelope{}, err
	}
	e := Envelope{SchemaVersion: SchemaVersion, MessageID: messageID, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), Nonce: nonce, TenantID: tenantID, AgentID: id.AgentID, Type: messageType, Payload: raw}
	e.Signature = id.Sign([]byte(e.Canonical()))
	return e, nil
}

// JSON.stringify does not HTML-escape <, >, or &, so the Sidecar must use
// the same representation before hashing payloads for Cloud verification.
func marshalPayload(payload any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func (e Envelope) Canonical() string {
	sum := sha256.Sum256(e.Payload)
	return strings.Join([]string{e.MessageID, e.Timestamp, e.Nonce, e.TenantID, e.AgentID, e.Type, hex.EncodeToString(sum[:])}, "|")
}
