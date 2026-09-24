package executor

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/mcai/sidecar-agent/internal/audit"
	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

type recoveryProvider struct {
	instance       provider.Instance
	listCalls      int
	listFailures   int
	listError      error
	startCalls     int
	stopCalls      int
	startError     error
	stopError      error
	startState     string
	stopState      string
	commandCalls   int
	commandError   error
	commandOutput  string
	commandOutputs []string
	outputReads    int
}

func (p *recoveryProvider) ListInstances(context.Context) ([]provider.Instance, error) {
	return []provider.Instance{p.instance}, nil
}
func (p *recoveryProvider) ReadOutput(context.Context, string, int) (string, error) {
	p.outputReads++
	if p.outputReads == 1 {
		return "", nil
	}
	if len(p.commandOutputs) > 0 {
		index := p.outputReads - 2
		if index >= len(p.commandOutputs) {
			index = len(p.commandOutputs) - 1
		}
		return p.commandOutputs[index], nil
	}
	return p.commandOutput, nil
}
func (p *recoveryProvider) ListFiles(context.Context, string, string) (string, error) {
	p.listCalls++
	if p.listCalls <= p.listFailures {
		return "", p.listError
	}
	return "server.jar", nil
}
func (p *recoveryProvider) ListFileEntries(context.Context, string, string) (provider.FileListing, error) {
	p.listCalls++
	if p.listCalls <= p.listFailures {
		return provider.FileListing{}, p.listError
	}
	return provider.FileListing{Names: []string{"server.jar"}, Total: 1}, nil
}
func (p *recoveryProvider) DownloadFromURL(context.Context, string, string, string) error { return nil }
func (p *recoveryProvider) UpdateStartConfig(context.Context, string, provider.StartConfig) error {
	return nil
}
func (p *recoveryProvider) ReadFile(context.Context, string, string) ([]byte, error) { return nil, nil }
func (p *recoveryProvider) WriteFile(context.Context, string, string, []byte) error  { return nil }
func (p *recoveryProvider) SendCommand(context.Context, string, string) error {
	p.commandCalls++
	return p.commandError
}
func (p *recoveryProvider) Start(context.Context, string) error {
	p.startCalls++
	if p.startState != "" {
		p.instance.State = p.startState
	}
	return p.startError
}
func (p *recoveryProvider) Stop(context.Context, string) error {
	p.stopCalls++
	if p.stopState != "" {
		p.instance.State = p.stopState
	}
	return p.stopError
}
func (p *recoveryProvider) Restart(context.Context, string) error { return nil }
func (p *recoveryProvider) GetInstance(context.Context, string) (provider.Instance, error) {
	return p.instance, nil
}

type recordedEvent struct {
	state   string
	kind    string
	summary string
}

func newRecoveryExecutor(t *testing.T, p provider.Provider) *Executor {
	t.Helper()
	writer, err := audit.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executor := NewWithReleaseResolver(t.TempDir(), writer, nil)
	executor.Register("mcs", p)
	executor.retryDelay = func(int) time.Duration { return 0 }
	executor.consolePollDelay = 0
	return executor
}

func recoveryPlan() protocol.TaskPlan {
	return protocol.TaskPlan{
		SchemaVersion:     "task-plan/v1",
		TaskID:            "task-recovery",
		InstanceRef:       "mcs:daemon:instance",
		Intent:            "list files and verify the instance",
		InventoryRevision: "rev-1",
		Steps: []protocol.TaskStep{{
			ID: "s1", Tool: "files.list", Args: map[string]any{"path": "/"}, Risk: "read",
		}},
		Acceptance: []protocol.AcceptanceRule{{Type: "instance_state", Expected: "running"}},
	}
}

func runRecoveryPlan(t *testing.T, p *recoveryProvider) []recordedEvent {
	return runPlan(t, p, recoveryPlan())
}

func runPlan(t *testing.T, p *recoveryProvider, plan protocol.TaskPlan) []recordedEvent {
	t.Helper()
	executor := newRecoveryExecutor(t, p)
	var events []recordedEvent
	executor.Execute(context.Background(), plan, func(state, kind, summary string, _ ...map[string]any) {
		events = append(events, recordedEvent{state: state, kind: kind, summary: summary})
	})
	return events
}

func TestExecuteRetriesTransientToolFailureThenVerifies(t *testing.T) {
	p := &recoveryProvider{
		instance:     provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1"},
		listFailures: 2,
		listError:    errors.New("temporary service unavailable"),
	}
	events := runRecoveryPlan(t, p)
	if p.listCalls != 3 {
		t.Fatalf("ListFiles called %d times, want 3", p.listCalls)
	}
	if countEvents(events, "recovery") != 2 {
		t.Fatalf("recovery events = %d, want 2: %#v", countEvents(events, "recovery"), events)
	}
	if events[len(events)-1].state != "SUCCEEDED" {
		t.Fatalf("final event = %#v, want SUCCEEDED", events[len(events)-1])
	}
}

func TestExecuteStopsAfterRepeatedIdenticalTransientFailure(t *testing.T) {
	p := &recoveryProvider{
		instance:     provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1"},
		listFailures: 20,
		listError:    errors.New("temporary service unavailable"),
	}
	events := runRecoveryPlan(t, p)
	if p.listCalls != defaultMaxAttempts {
		t.Fatalf("ListFiles called %d times, want %d", p.listCalls, defaultMaxAttempts)
	}
	if events[len(events)-1].state != "FAILED" {
		t.Fatalf("final event = %#v, want FAILED", events[len(events)-1])
	}
}

func TestExecuteDoesNotRepeatDeterministicFailure(t *testing.T) {
	p := &recoveryProvider{
		instance:     provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1"},
		listFailures: 20,
		listError:    errors.New("permission denied"),
	}
	events := runRecoveryPlan(t, p)
	if p.listCalls != 1 {
		t.Fatalf("ListFiles called %d times, want 1", p.listCalls)
	}
	if countEvents(events, "recovery") != 0 || events[len(events)-1].state != "FAILED" {
		t.Fatalf("unexpected recovery for deterministic failure: %#v", events)
	}
}

func TestExecuteDoesNotRepeatAConfirmedOperation(t *testing.T) {
	p := &recoveryProvider{
		instance:     provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1"},
		listFailures: 20,
		listError:    errors.New("temporary service unavailable"),
	}
	plan := recoveryPlan()
	plan.Steps[0].Risk = "medium"
	plan.Steps[0].RequiresConfirmation = true
	events := runPlan(t, p, plan)
	if p.listCalls != 1 {
		t.Fatalf("confirmed operation was repeated %d times", p.listCalls)
	}
	if countEvents(events, "recovery") != 0 || events[len(events)-1].state != "FAILED" {
		t.Fatalf("unexpected recovery for confirmed operation: %#v", events)
	}
}

func TestConfirmedExecutionOnlyCommandReportsUnverifiedSuccess(t *testing.T) {
	p := &recoveryProvider{instance: provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1"}, commandOutput: "Set the weather to clear"}
	plan := recoveryPlan()
	plan.Intent = "set a gameplay value"
	plan.Steps = []protocol.TaskStep{{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "weather clear"}, Risk: "medium", RequiresConfirmation: true}}
	plan.Acceptance = nil
	events := runPlan(t, p, plan)
	if p.commandCalls != 1 {
		t.Fatalf("console command calls = %d, want exactly 1", p.commandCalls)
	}
	last := events[len(events)-1]
	if last.state != "SUCCEEDED" || last.kind != "execution" || !strings.Contains(last.summary, "not independently verified") {
		t.Fatalf("execution-only result did not preserve unverified semantics: %#v", events)
	}
}

func TestConfirmedExecutionOnlyCommandFailureIsAuthoritative(t *testing.T) {
	p := &recoveryProvider{instance: provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1"}, commandError: errors.New("panel rejected console command")}
	plan := recoveryPlan()
	plan.Steps = []protocol.TaskStep{{ID: "s1", Tool: "console.command", Args: map[string]any{"command": "weather clear"}, Risk: "medium", RequiresConfirmation: true}}
	plan.Acceptance = nil
	events := runPlan(t, p, plan)
	if p.commandCalls != 1 || events[len(events)-1].state != "FAILED" || !strings.Contains(events[len(events)-1].summary, "panel rejected") {
		t.Fatalf("tool failure was not authoritative: %#v", events)
	}
}

func TestConfirmedConsoleBusinessRejectionCannotBecomeExecutionSuccess(t *testing.T) {
	p := &recoveryProvider{
		instance:      provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1"},
		commandOutput: "No entities were found",
	}
	plan := recoveryPlan()
	plan.Steps = []protocol.TaskStep{{ID: "s1", Tool: "console.command", Args: map[string]any{"command": `title @a actionbar {"text":"Round begins soon"}`}, Risk: "medium", RequiresConfirmation: true}}
	plan.Acceptance = nil
	events := runPlan(t, p, plan)
	if p.commandCalls != 1 || events[len(events)-1].state != "FAILED" || !strings.Contains(events[len(events)-1].summary, "没有找到符合条件的目标") {
		t.Fatalf("zero-target callback was not authoritative: %#v", events)
	}
	if !containsEvent(events, "No entities were found") {
		t.Fatalf("raw callback evidence was not preserved: %#v", events)
	}
}

func TestConfirmedConsoleWaitsPastFragmentsForACompleteBusinessOutcome(t *testing.T) {
	p := &recoveryProvider{
		instance:       provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1"},
		commandOutputs: []string{"t", "No pla", "No player was found"},
	}
	plan := recoveryPlan()
	plan.Steps = []protocol.TaskStep{{ID: "s1", Tool: "console.command", Args: map[string]any{"command": `tellraw @a {"text":"Match starts soon"}`}, Risk: "high", RequiresConfirmation: true}}
	plan.Acceptance = nil
	events := runPlan(t, p, plan)
	if p.outputReads < 4 {
		t.Fatalf("executor returned before the complete callback: reads=%d events=%#v", p.outputReads, events)
	}
	if events[len(events)-1].state != "FAILED" || !strings.Contains(events[len(events)-1].summary, "没有找到符合条件的目标") {
		t.Fatalf("fragmented zero-target callback did not converge to failure: %#v", events)
	}
}

func TestConfirmedConsoleNeverPromotesAStableTruncatedFragment(t *testing.T) {
	p := &recoveryProvider{
		instance:       provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1"},
		commandOutputs: []string{"t"},
	}
	plan := recoveryPlan()
	plan.Steps = []protocol.TaskStep{{ID: "s1", Tool: "console.command", Args: map[string]any{"command": `tellraw @a {"text":"Queue is open"}`}, Risk: "high", RequiresConfirmation: true}}
	plan.Acceptance = nil
	events := runPlan(t, p, plan)
	if events[len(events)-1].state != "FAILED" {
		t.Fatalf("truncated callback was promoted: %#v", events)
	}
	if containsEvent(events, "Executed successfully") {
		t.Fatalf("truncated callback produced success evidence: %#v", events)
	}
}

func TestStartAlreadyRunningIsIdempotent(t *testing.T) {
	p := &recoveryProvider{instance: provider.Instance{
		Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1",
	}}
	plan := recoveryPlan()
	plan.Intent = "start the current instance"
	plan.Steps = []protocol.TaskStep{{ID: "s1", Tool: "instance.start", Risk: "low"}}
	events := runPlan(t, p, plan)
	if p.startCalls != 0 {
		t.Fatalf("Start called %d times for an already-running instance", p.startCalls)
	}
	if events[len(events)-1].state != "SUCCEEDED" || !containsEvent(events, "实例已在运行") {
		t.Fatalf("unexpected idempotent start result: %#v", events)
	}
}

func TestStopAlreadyStoppedIsIdempotent(t *testing.T) {
	p := &recoveryProvider{instance: provider.Instance{
		Ref: "mcs:daemon:instance", State: "stopped", ProfileRevision: "rev-1",
	}}
	plan := recoveryPlan()
	plan.Intent = "stop the current instance"
	plan.Steps = []protocol.TaskStep{{ID: "s1", Tool: "instance.stop", Risk: "high", RequiresConfirmation: true}}
	plan.Acceptance = []protocol.AcceptanceRule{{Type: "instance_state", Expected: "stopped"}}
	events := runPlan(t, p, plan)
	if p.stopCalls != 0 {
		t.Fatalf("Stop called %d times for an already-stopped instance", p.stopCalls)
	}
	if events[len(events)-1].state != "SUCCEEDED" || !containsEvent(events, "实例已经停止") {
		t.Fatalf("unexpected idempotent stop result: %#v", events)
	}
}

func TestStartResponseErrorUsesObservedTargetState(t *testing.T) {
	p := &recoveryProvider{
		instance:   provider.Instance{Ref: "mcs:daemon:instance", State: "stopped", ProfileRevision: "rev-1"},
		startError: errors.New("panel returned HTTP 500"),
		startState: "running",
	}
	plan := recoveryPlan()
	plan.Intent = "start the current instance"
	plan.Steps = []protocol.TaskStep{{ID: "s1", Tool: "instance.start", Risk: "low"}}
	events := runPlan(t, p, plan)
	if p.startCalls != 1 || events[len(events)-1].state != "SUCCEEDED" {
		t.Fatalf("start race was not reconciled: calls=%d events=%#v", p.startCalls, events)
	}
}

func TestVerificationEventSinkSeparatesReadbackEvidence(t *testing.T) {
	var events []recordedEvent
	sink := verificationEventSink(func(state, kind, summary string, _ ...map[string]any) {
		events = append(events, recordedEvent{state: state, kind: kind, summary: summary})
	})
	sink("", "files", "plugins contains Example.jar")
	sink("", "diagnosis", "temporary readback error")

	if events[0].kind != "verification.files" {
		t.Fatalf("verification evidence kind = %q", events[0].kind)
	}
	if events[1].kind != "diagnosis" {
		t.Fatalf("diagnosis was incorrectly reclassified as %q", events[1].kind)
	}
}

func countEvents(events []recordedEvent, kind string) int {
	count := 0
	for _, event := range events {
		if event.kind == kind || strings.Contains(event.summary, kind) {
			count++
		}
	}
	return count
}

func containsEvent(events []recordedEvent, text string) bool {
	for _, event := range events {
		if strings.Contains(event.summary, text) {
			return true
		}
	}
	return false
}
