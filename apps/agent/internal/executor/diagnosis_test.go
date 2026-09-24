package executor

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

type diagnosisProvider struct {
	*installProvider
	output      string
	outputReads int
	readFileErr error
	readCalls   int
	startErr    error
	startCalls  int
}

func (p *diagnosisProvider) ReadOutput(context.Context, string, int) (string, error) {
	p.outputReads++
	return p.output, nil
}

func (p *diagnosisProvider) ReadFile(ctx context.Context, instanceRef, path string) ([]byte, error) {
	p.readCalls++
	if p.readFileErr != nil {
		return nil, p.readFileErr
	}
	return p.installProvider.ReadFile(ctx, instanceRef, path)
}

func (p *diagnosisProvider) Start(context.Context, string) error {
	p.startCalls++
	return p.startErr
}

func TestClassifyFailure(t *testing.T) {
	tests := []struct {
		name   string
		cause  string
		output string
		state  string
		want   string
	}{
		{name: "eula", output: "You need to agree to the EULA", want: "EULA"},
		{name: "port", output: "FAILED TO BIND TO PORT: Address already in use", want: "端口"},
		{name: "java", output: "java.lang.UnsupportedClassVersionError", want: "Java"},
		{name: "memory", output: "java.lang.OutOfMemoryError: Java heap space", want: "内存"},
		{name: "jar", cause: "Unable to access jarfile server.jar", want: "JAR"},
		{name: "permission", cause: "permission denied", want: "权限"},
		{name: "dependency", output: "Missing mandatory dependencies", want: "依赖"},
		{name: "stopped fallback", cause: "start timeout", state: "stopped", want: "停止"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := classifyFailure(test.cause, test.output, test.state)
			if !strings.Contains(got, test.want) {
				t.Fatalf("classifyFailure() = %q, want it to contain %q", got, test.want)
			}
		})
	}
}

func TestSanitizeDiagnostic(t *testing.T) {
	got := sanitizeDiagnostic("request failed token=abc123 password:secret")
	if strings.Contains(got, "abc123") || strings.Contains(got, "secret") {
		t.Fatalf("sanitizeDiagnostic leaked a credential: %q", got)
	}
}

func TestConfigInspectFailureIgnoresStaleStartupEULA(t *testing.T) {
	p := &diagnosisProvider{
		installProvider: &installProvider{instance: provider.Instance{Ref: "mcs:daemon:instance", State: "stopped", ProfileRevision: "rev-1"}},
		output:          "You need to agree to the EULA before the server can start",
		readFileErr:     errors.New("panel returned HTTP 500"),
	}
	executor := newRecoveryExecutor(t, p)
	var events []recordedEvent
	executor.Execute(context.Background(), protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", TaskID: "config-failure", InstanceRef: "mcs:daemon:instance", InventoryRevision: "rev-1",
		Steps: []protocol.TaskStep{{ID: "s1", Tool: "config.inspect", Args: map[string]any{"path": "missing.yml"}, Risk: "read"}},
	}, func(state, kind, summary string, _ ...map[string]any) {
		events = append(events, recordedEvent{state: state, kind: kind, summary: summary})
	})
	got := recordedEventText(events)
	if p.readCalls != defaultMaxAttempts {
		t.Fatalf("config.inspect read %d times, want bounded retries=%d", p.readCalls, defaultMaxAttempts)
	}
	if p.outputReads != 0 {
		t.Fatalf("config.inspect diagnosis read stale server output %d times", p.outputReads)
	}
	if strings.Contains(got, "EULA") || !strings.Contains(got, "HTTP 500") || !strings.Contains(got, "FAILED") {
		t.Fatalf("read-tool diagnosis used an unrelated launch failure: %q", got)
	}
}

func TestInstanceStartFailureUsesStartupEULA(t *testing.T) {
	p := &diagnosisProvider{
		installProvider: &installProvider{instance: provider.Instance{Ref: "mcs:daemon:instance", State: "stopped", ProfileRevision: "rev-1"}},
		output:          "You need to agree to the EULA before the server can start",
		startErr:        errors.New("panel returned HTTP 500"),
	}
	executor := newRecoveryExecutor(t, p)
	var events []recordedEvent
	executor.Execute(context.Background(), protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", TaskID: "start-failure", InstanceRef: "mcs:daemon:instance", InventoryRevision: "rev-1",
		Steps: []protocol.TaskStep{{ID: "s1", Tool: "instance.start", Risk: "low"}},
	}, func(state, kind, summary string, _ ...map[string]any) {
		events = append(events, recordedEvent{state: state, kind: kind, summary: summary})
	})
	got := recordedEventText(events)
	if p.startCalls != 1 {
		t.Fatalf("instance.start called %d times, want 1", p.startCalls)
	}
	if p.outputReads != 1 {
		t.Fatalf("instance.start diagnosis read server output %d times, want 1", p.outputReads)
	}
	if !strings.Contains(got, "EULA") || !strings.Contains(got, "FAILED") || countEvents(events, "recovery") != 0 {
		t.Fatalf("start diagnosis did not use the current launch output: %q", got)
	}
}

func recordedEventText(events []recordedEvent) string {
	lines := make([]string, 0, len(events))
	for _, event := range events {
		lines = append(lines, event.state+"|"+event.kind+"|"+event.summary)
	}
	return strings.Join(lines, "\n")
}

func TestLatestServerAttemptIgnoresPriorLaunchFailure(t *testing.T) {
	output := strings.Join([]string{
		"Error: Invalid or corrupt jarfile server.jar",
		"[13:34:08 INFO]: [bootstrap] Running Java 25",
		"[13:34:35 INFO]: Done (29.175s)! For help, type \"help\"",
	}, "\n")
	if got := classifyFailure("server did not reach ready", output, "running"); strings.Contains(got, "JAR") {
		t.Fatalf("prior launch error leaked into diagnosis: %q", got)
	}
	if !isServerReady(output) {
		t.Fatal("expected current ready signal to be detected")
	}
}

func TestLatestServerAttemptDetectsCurrentTerminalFailure(t *testing.T) {
	output := strings.Join([]string{
		"[13:34:35 INFO]: Done (29.175s)! For help, type \"help\"",
		"> /usr/bin/java -jar server.jar nogui",
		"Error: Invalid or corrupt jarfile server.jar",
	}, "\n")
	if isServerReady(output) {
		t.Fatal("a previous ready signal must not satisfy the current launch")
	}
	if !hasTerminalStartupFailure(output) {
		t.Fatal("expected the current launch failure to be detected")
	}
}
