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
	instance     provider.Instance
	listCalls    int
	listFailures int
	listError    error
}

func (p *recoveryProvider) ListInstances(context.Context) ([]provider.Instance, error) {
	return []provider.Instance{p.instance}, nil
}
func (p *recoveryProvider) ReadOutput(context.Context, string, int) (string, error) { return "", nil }
func (p *recoveryProvider) ListFiles(context.Context, string, string) (string, error) {
	p.listCalls++
	if p.listCalls <= p.listFailures {
		return "", p.listError
	}
	return "server.jar", nil
}
func (p *recoveryProvider) DownloadFromURL(context.Context, string, string, string) error { return nil }
func (p *recoveryProvider) UpdateStartConfig(context.Context, string, provider.StartConfig) error {
	return nil
}
func (p *recoveryProvider) ReadFile(context.Context, string, string) ([]byte, error) { return nil, nil }
func (p *recoveryProvider) WriteFile(context.Context, string, string, []byte) error  { return nil }
func (p *recoveryProvider) Start(context.Context, string) error                      { return nil }
func (p *recoveryProvider) Restart(context.Context, string) error                    { return nil }
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
	executor.Execute(context.Background(), plan, func(state, kind, summary string) {
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

func countEvents(events []recordedEvent, kind string) int {
	count := 0
	for _, event := range events {
		if event.kind == kind || strings.Contains(event.summary, kind) {
			count++
		}
	}
	return count
}
