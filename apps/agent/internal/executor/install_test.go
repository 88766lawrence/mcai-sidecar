package executor

import (
	"context"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/logquery"
	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

type resolverFunc func(context.Context, string, string) (releaseArtifact, error)

func (f resolverFunc) Resolve(ctx context.Context, platform, minecraftVersion string) (releaseArtifact, error) {
	return f(ctx, platform, minecraftVersion)
}

type installProvider struct {
	instance     provider.Instance
	downloaded   string
	configured   provider.StartConfig
	started      bool
	stopped      bool
	commands     []string
	outputBefore string
	outputAfter  string
	logBefore    string
	logAfter     string
	files        map[string][]byte
}

func TestInstanceMetricsEmitsAuthoritativeMemoryUsage(t *testing.T) {
	fake := &installProvider{instance: provider.Instance{Ref: "mcs:daemon:instance", State: "running", ProfileRevision: "rev-1", MemoryBytes: 805306368, MemoryLimitBytes: 2147483648, CPUUsage: 4.25}}
	exec := New(t.TempDir(), nil)
	var events []string
	err := exec.executeStep(context.Background(), fake, protocol.TaskPlan{
		SchemaVersion: "task-plan/v1", TaskID: "metrics-read", InstanceRef: "mcs:daemon:instance", InventoryRevision: "rev-1",
	}, protocol.TaskStep{ID: "s1", Tool: "instance.metrics", Args: map[string]any{"schema_version": "instance-metrics/v2", "metrics": []any{"cpu", "memory"}, "include_capacity": true}, Risk: "read"},
		func(state, kind, summary string, _ ...map[string]any) {
			events = append(events, state+"|"+kind+"|"+summary)
		})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(events, "\n")
	if !strings.Contains(joined, "|metrics|Instance metrics v2: uptime_seconds=0; cpu_percent=4.25; memory_bytes=805306368; memory_limit_bytes=2147483648; pressure_policy=resource-pressure/v1") {
		t.Fatalf("missing authoritative memory event: %s", joined)
	}
}

func TestInstanceMetricsRejectsMissingCapacityAndInvalidMetricSet(t *testing.T) {
	exec := New(t.TempDir(), nil)
	plan := protocol.TaskPlan{SchemaVersion: "task-plan/v1", TaskID: "metrics-read", InstanceRef: "mcs:daemon:instance", InventoryRevision: "rev-1"}
	fake := &installProvider{instance: provider.Instance{Ref: plan.InstanceRef, State: "running", MemoryBytes: 10, CPUUsage: 1}}
	step := protocol.TaskStep{ID: "s1", Tool: "instance.metrics", Args: map[string]any{"schema_version": "instance-metrics/v2", "metrics": []any{"cpu", "memory"}, "include_capacity": true}, Risk: "read"}
	if err := exec.executeStep(context.Background(), fake, plan, step, func(string, string, string, ...map[string]any) {}); err == nil || !strings.Contains(err.Error(), "memory capacity") {
		t.Fatalf("expected missing capacity rejection, got %v", err)
	}
	step.Args["metrics"] = []any{"memory", "disk"}
	if err := exec.executeStep(context.Background(), fake, plan, step, func(string, string, string, ...map[string]any) {}); err == nil || !strings.Contains(err.Error(), "registered") {
		t.Fatalf("expected invalid metric rejection, got %v", err)
	}
}

func (p *installProvider) ListInstances(context.Context) ([]provider.Instance, error) {
	return []provider.Instance{p.instance}, nil
}
func (p *installProvider) ReadOutput(context.Context, string, int) (string, error) {
	if len(p.commands) > 0 {
		return p.outputAfter, nil
	}
	return p.outputBefore, nil
}
func (p *installProvider) ListFiles(context.Context, string, string) (string, error) {
	return p.downloaded, nil
}
func (p *installProvider) DownloadFromURL(_ context.Context, _ string, sourceURL, fileName string) error {
	p.downloaded = fileName
	if sourceURL == "" {
		return context.Canceled
	}
	return nil
}
func (p *installProvider) UpdateStartConfig(_ context.Context, _ string, config provider.StartConfig) error {
	p.configured = config
	return nil
}
func (p *installProvider) ReadFile(_ context.Context, _ string, path string) ([]byte, error) {
	if path == "logs/latest.log" {
		if len(p.commands) > 0 {
			return []byte(p.logAfter), nil
		}
		return []byte(p.logBefore), nil
	}
	return p.files[path], nil
}
func (p *installProvider) WriteFile(_ context.Context, _ string, path string, contents []byte) error {
	if p.files == nil {
		p.files = make(map[string][]byte)
	}
	p.files[path] = append([]byte(nil), contents...)
	return nil
}
func (p *installProvider) SendCommand(_ context.Context, _ string, command string) error {
	p.commands = append(p.commands, command)
	return nil
}
func (p *installProvider) Start(context.Context, string) error {
	p.started = true
	return nil
}
func (p *installProvider) Stop(context.Context, string) error {
	p.stopped = true
	p.instance.State = "stopped"
	return nil
}
func (p *installProvider) Restart(context.Context, string) error { return nil }
func (p *installProvider) GetInstance(context.Context, string) (provider.Instance, error) {
	return p.instance, nil
}

func TestConsoleCommandRequiresRiskAndConfirmation(t *testing.T) {
	p := &installProvider{
		instance:     provider.Instance{State: "running"},
		outputBefore: "[Server thread/INFO]: previous line\n",
		outputAfter:  "[Server thread/INFO]: previous line\n[Server thread/INFO]: There are 0 of a max of 20 players online:\n",
	}
	executor := NewWithReleaseResolver("", nil, nil)
	plan := protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}
	var consoleEvidence string

	if err := executor.executeStep(context.Background(), p, plan, protocol.TaskStep{
		Tool: "console.command", Args: map[string]any{"command": "list"}, Risk: "read",
	}, func(_, kind, summary string, _ ...map[string]any) {
		if kind == "console" {
			consoleEvidence = summary
		}
	}); err != nil {
		t.Fatal(err)
	}
	if len(p.commands) != 1 || p.commands[0] != "list" {
		t.Fatalf("console command was not sent: %#v", p.commands)
	}
	if !strings.Contains(consoleEvidence, "There are 0 of a max of 20 players online") {
		t.Fatalf("console output was not returned as evidence: %q", consoleEvidence)
	}

	err := executor.executeStep(context.Background(), p, plan, protocol.TaskStep{
		Tool: "console.command", Args: map[string]any{"command": "op Steve"}, Risk: "low",
	}, func(_, _, _ string, _ ...map[string]any) {})
	if err == nil || !strings.Contains(err.Error(), "requires high risk") {
		t.Fatalf("expected high-risk rejection, got %v", err)
	}

	err = executor.executeStep(context.Background(), p, plan, protocol.TaskStep{
		Tool: "console.command", Args: map[string]any{"command": "op Steve"}, Risk: "high",
	}, func(_, _, _ string, _ ...map[string]any) {})
	if err == nil || !strings.Contains(err.Error(), "requires explicit confirmation") {
		t.Fatalf("expected confirmation rejection, got %v", err)
	}

	actionbar := `title @a actionbar {"text":"Maintenance begins soon"}`
	gotCommand, gotRisk, err := validateConsoleCommand(protocol.TaskStep{
		Tool:                 "console.command",
		Args:                 map[string]any{"command": actionbar},
		Risk:                 "medium",
		RequiresConfirmation: true,
	})
	if err != nil || gotCommand != actionbar || gotRisk != "medium" {
		t.Fatalf("expected confirmed actionbar command to pass, command=%q risk=%q err=%v", gotCommand, gotRisk, err)
	}
}

func TestBareDifficultyQueryIsReadOnlyButDifficultyChangeRequiresConfirmation(t *testing.T) {
	query := protocol.TaskStep{Tool: "console.command", Args: map[string]any{"command": "difficulty"}, Risk: "read"}
	command, risk, err := validateConsoleCommand(query)
	if err != nil || command != "difficulty" || risk != "read" {
		t.Fatalf("expected a read-only difficulty query, command=%q risk=%q err=%v", command, risk, err)
	}

	change := protocol.TaskStep{Tool: "console.command", Args: map[string]any{"command": "difficulty easy"}, Risk: "read"}
	if _, _, err := validateConsoleCommand(change); err == nil || !strings.Contains(err.Error(), "requires medium risk") {
		t.Fatalf("expected difficulty mutation risk rejection, got %v", err)
	}
}

func TestWhitelistReadbackAndMutationUseDifferentRisks(t *testing.T) {
	query := protocol.TaskStep{Tool: "console.command", Args: map[string]any{"command": "whitelist list"}, Risk: "read"}
	if _, risk, err := validateConsoleCommand(query); err != nil || risk != "read" {
		t.Fatalf("expected read-only whitelist query, risk=%q err=%v", risk, err)
	}
	change := protocol.TaskStep{Tool: "console.command", Args: map[string]any{"command": "whitelist add RiverFox"}, Risk: "read"}
	if _, _, err := validateConsoleCommand(change); err == nil || !strings.Contains(err.Error(), "requires medium risk") {
		t.Fatalf("expected whitelist mutation risk rejection, got %v", err)
	}
}

func TestExactPlayerGameModeReadbackIsReadOnly(t *testing.T) {
	query := protocol.TaskStep{
		Tool: "console.command", Args: map[string]any{"command": "data get entity NovaRider playerGameType"}, Risk: "read",
	}
	if _, risk, err := validateConsoleCommand(query); err != nil || risk != "read" {
		t.Fatalf("expected exact playerGameType readback to be read-only, risk=%q err=%v", risk, err)
	}
	unsafe := protocol.TaskStep{Tool: "console.command", Args: map[string]any{"command": "data merge entity NovaRider {}"}, Risk: "read"}
	if _, _, err := validateConsoleCommand(unsafe); err == nil || !strings.Contains(err.Error(), "requires high risk") {
		t.Fatalf("expected arbitrary data mutation to remain high risk, got %v", err)
	}
}

func TestBoundedRuntimeReadbacksAreReadOnly(t *testing.T) {
	for _, command := range []string{"time query daytime", "gamerule keepInventory", "worldborder get", "datapack list enabled"} {
		step := protocol.TaskStep{Tool: "console.command", Args: map[string]any{"command": command}, Risk: "read"}
		if _, risk, err := validateConsoleCommand(step); err != nil || risk != "read" {
			t.Fatalf("expected %q to be read-only, risk=%q err=%v", command, risk, err)
		}
	}
}

func TestLogsQueryReturnsSanitizedRecentEvidence(t *testing.T) {
	p := &installProvider{
		outputBefore: "short panel tail",
		logBefore: strings.Join([]string{
			"[Server thread/INFO]: Done (12.3s)! For help, type help",
			"[Server thread/ERROR]: java.lang.OutOfMemoryError: Java heap space",
			"token=abc123 password:secret",
		}, "\n"),
	}
	executor := NewWithReleaseResolver("", nil, nil)
	var logEvidence string

	err := executor.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{
		Tool: "logs.query", Risk: "read",
	}, func(_, kind, summary string, _ ...map[string]any) {
		if kind == "logs" {
			logEvidence = summary
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logEvidence, "OutOfMemoryError") || !strings.Contains(logEvidence, "Log query result: matches=3") || !strings.Contains(logEvidence, "sample_count=3") {
		t.Fatalf("log excerpt was not returned as evidence: %q", logEvidence)
	}
	if strings.Contains(logEvidence, "short panel tail") {
		t.Fatalf("logs.query did not prefer the more complete latest.log: %q", logEvidence)
	}
	if strings.Contains(logEvidence, "abc123") || strings.Contains(logEvidence, "secret") {
		t.Fatalf("log evidence leaked credentials: %q", logEvidence)
	}
}

func TestLogsQueryAppliesBoundedWindowAndFiltersWithTypedMetadata(t *testing.T) {
	p := &installProvider{logBefore: strings.Join([]string{
		"[10:00:00] [Server thread/INFO]: old connection timed out",
		"[11:55:00] [Server thread/INFO]: player joined",
		"[11:56:00] [Server thread/WARN]: Login authentication failed for guest",
		"[11:57:00] [Server thread/INFO]: Connection timed out",
		"[12:00:00] [Server thread/INFO]: heartbeat",
	}, "\n")}
	executor := NewWithReleaseResolver("", nil, nil)
	var evidence string
	err := executor.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{
		Tool: "logs.query", Risk: "read", Args: map[string]any{
			"window_minutes": float64(10), "max_lines": float64(100), "filters": []any{"authentication_failure", "timeout"},
		},
	}, func(_, kind, summary string, _ ...map[string]any) {
		if kind == "logs" {
			evidence = summary
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(evidence, "matches=2; window_minutes=10; scanned_lines=4; sample_count=2") {
		t.Fatalf("missing typed log query metadata: %q", evidence)
	}
	if strings.Contains(evidence, "old connection timed out") || strings.Contains(evidence, "player joined") {
		t.Fatalf("log query ignored its bounded window or filters: %q", evidence)
	}
}

func TestLogsQueryZeroMatchIsAuthoritative(t *testing.T) {
	p := &installProvider{logBefore: "[12:00:00] [Server thread/INFO]: heartbeat"}
	executor := NewWithReleaseResolver("", nil, nil)
	var evidence string
	err := executor.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{
		Tool: "logs.query", Risk: "read", Args: map[string]any{"window_minutes": float64(20), "max_lines": float64(100), "filters": []any{"timeout"}},
	}, func(_, kind, summary string, _ ...map[string]any) {
		if kind == "logs" {
			evidence = summary
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(evidence, "matches=0") || !strings.Contains(evidence, "sample_count=0") || !strings.Contains(evidence, "Matched samples: <none>") {
		t.Fatalf("zero-match result is not auditable: %q", evidence)
	}
}

func TestLogsQueryAcceptsCanonicalMultiGroupQueryWithMoreThanEightEventFilters(t *testing.T) {
	query := logquery.New([]logquery.Group{
		{AnyOf: []string{"out_of_memory", "heap_exhaustion", "gc_overhead", "cannot_keep_up", "tick_timeout"}},
		{AnyOf: []string{"initialization_failure", "dependency_missing", "crash", "error"}},
	})
	filters := make([]any, 0, len(logquery.EventFilters(query)))
	for _, filter := range logquery.EventFilters(query) {
		filters = append(filters, filter)
	}
	args := map[string]any{
		"window_minutes": float64(60), "max_lines": float64(100),
		"filters": filters, "filter_query": query,
	}
	if _, _, _, _, err := validatedLogQueryArgs(args); err != nil {
		t.Fatalf("canonical multi-group query was rejected by a conflicting flat-filter limit: %v", err)
	}

	invalid := logquery.New([]logquery.Group{{AnyOf: []string{
		"out_of_memory", "heap_exhaustion", "gc_overhead", "cannot_keep_up", "tick_timeout",
		"initialization_failure", "dependency_missing", "crash", "error",
	}}})
	invalidFilters := make([]any, 0, len(logquery.EventFilters(invalid)))
	for _, filter := range logquery.EventFilters(invalid) {
		invalidFilters = append(invalidFilters, filter)
	}
	if _, _, _, _, err := validatedLogQueryArgs(map[string]any{
		"window_minutes": float64(60), "max_lines": float64(100),
		"filters": invalidFilters, "filter_query": invalid,
	}); err == nil {
		t.Fatal("single filter group with more than eight conditions was accepted")
	}
}

func TestLogsQueryRejectsUnboundedOrMalformedParameters(t *testing.T) {
	executor := NewWithReleaseResolver("", nil, nil)
	p := &installProvider{logBefore: "[12:00:00] ok"}
	for _, args := range []map[string]any{
		{"window_minutes": float64(0), "max_lines": float64(100)},
		{"window_minutes": float64(60), "max_lines": float64(5000)},
		{"window_minutes": float64(60), "max_lines": float64(100), "filters": []any{"bad\nfilter"}},
	} {
		err := executor.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{Tool: "logs.query", Risk: "read", Args: args}, func(_, _, _ string, _ ...map[string]any) {})
		if err == nil {
			t.Fatalf("expected unsafe log query args to be rejected: %#v", args)
		}
	}
}

func TestConsoleCommandRejectsLifecycleAndMultilineCommands(t *testing.T) {
	for _, command := range []string{"stop", "say hello\nop Steve"} {
		_, _, err := validateConsoleCommand(protocol.TaskStep{
			Args: map[string]any{"command": command}, Risk: "high", RequiresConfirmation: true,
		})
		if err == nil {
			t.Fatalf("expected %q to be rejected", command)
		}
	}
}

func TestConsoleCommandFallsBackToLatestLog(t *testing.T) {
	p := &installProvider{
		instance:     provider.Instance{State: "running"},
		outputBefore: "unchanged panel output",
		outputAfter:  "unchanged panel output",
		logBefore:    "[Server thread/INFO]: previous line\n",
		logAfter: strings.Join([]string{
			"[Server thread/INFO]: previous line",
			"[Server thread/INFO]: There are 0 of a max of 20 players online:",
		}, "\n"),
	}
	executor := NewWithReleaseResolver("", nil, nil)
	var consoleEvidence string

	err := executor.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{
		Tool: "console.command", Args: map[string]any{"command": "list"}, Risk: "read",
	}, func(_, kind, summary string, _ ...map[string]any) {
		if kind == "console" {
			consoleEvidence = summary
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(consoleEvidence, "There are 0 of a max of 20 players online") {
		t.Fatalf("latest.log output was not returned as evidence: %q", consoleEvidence)
	}
}

func TestConsoleCommandFailsWithoutReadableOutput(t *testing.T) {
	p := &installProvider{
		instance:     provider.Instance{State: "running"},
		outputBefore: "unchanged panel output",
		outputAfter:  "unchanged panel output",
		logBefore:    "unchanged latest log",
		logAfter:     "unchanged latest log",
	}
	executor := NewWithReleaseResolver("", nil, nil)
	executor.consolePollDelay = 0

	err := executor.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{
		Tool: "console.command", Args: map[string]any{"command": "list"}, Risk: "read",
	}, func(_, _, _ string, _ ...map[string]any) {})
	if err == nil || err.Error() != "服务器没有返回可判断的命令结果，因此无法确认这次操作是否生效" {
		t.Fatalf("expected missing console evidence to fail, got %v", err)
	}
}

func TestConsoleEvidenceWaitsForFinalVersionLine(t *testing.T) {
	if consoleEvidenceComplete("version", "Checking version, please wait...") {
		t.Fatal("version progress output must not complete the command")
	}
	if !consoleEvidenceComplete("version", "This server is running Paper version 1.21.1-133") {
		t.Fatal("final Paper version output must complete the command")
	}
}

func TestConsoleEvidenceAcceptsPaperMSPTOutput(t *testing.T) {
	output := "Server tick times (avg/min/max) from last 5s, 10s, 1m:\n" +
		"0.1/0.0/0.2, 0.1/0.0/0.8, 0.1/0.0/3.0"
	if !consoleEvidenceComplete("mspt", output) {
		t.Fatal("Paper tick-time output must complete the mspt command")
	}
}

func TestConsoleEvidenceCorrelatesRuntimeReadResponsesToTheirCommands(t *testing.T) {
	vectors := []struct {
		command string
		stale   string
		result  string
	}{
		{"seed", "The difficulty is Easy", "Seed: [827364]"},
		{"difficulty", "The time is 18000", "The difficulty is Normal"},
		{"time query daytime", "The difficulty is Easy", "The time is 18000"},
		{"worldborder get", "The time is 18000", "The world border is currently 59999968 block(s) wide"},
		{"datapack list enabled", "The world border is currently 100 blocks wide", "There are 2 data pack(s) enabled: [vanilla], [file/custom]"},
		{"banlist players", "There are no more data packs available", "There are no bans"},
	}
	for _, vector := range vectors {
		if consoleEvidenceComplete(vector.command, vector.stale) {
			t.Fatalf("%q accepted stale output %q", vector.command, vector.stale)
		}
		if !consoleEvidenceComplete(vector.command, vector.result) {
			t.Fatalf("%q rejected its own output %q", vector.command, vector.result)
		}
	}
}

func TestInstallServerDownloadsConfiguresAndStarts(t *testing.T) {
	p := &installProvider{instance: provider.Instance{State: "stopped"}}
	executor := NewWithReleaseResolver("", nil, resolverFunc(func(_ context.Context, platform, minecraftVersion string) (releaseArtifact, error) {
		if platform != "fabric" || minecraftVersion != "1.20.4" {
			t.Fatalf("unexpected release lookup %q %q", platform, minecraftVersion)
		}
		return releaseArtifact{Platform: platform, MinecraftVersion: minecraftVersion, URL: "https://meta.fabricmc.net/server.jar", Name: "fabric-server-launch.jar"}, nil
	}))
	plan := protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}
	step := protocol.TaskStep{Tool: "server.install", Args: map[string]any{
		"platform": "fabric", "minecraft_version": "1.20.4", "target": "/server.jar", "accept_eula": true,
	}}

	if err := executor.installServer(context.Background(), p, plan, step, func(_, _, _ string, _ ...map[string]any) {}); err != nil {
		t.Fatal(err)
	}
	if p.downloaded != "/server.jar" || !p.started {
		t.Fatalf("installer did not download and start: %#v", p)
	}
	if !hasAcceptedEULA(p.files["eula.txt"]) {
		t.Fatal("installer did not persist verified EULA acceptance")
	}
	if p.configured.StartCommand != "/usr/bin/java -Xms512M -Xmx2G -jar server.jar nogui" || p.configured.StopCommand != "stop" || p.configured.StopTimeout != 30 {
		t.Fatalf("unexpected start config: %#v", p.configured)
	}
}

func TestInstallServerRequiresExplicitEULAAcceptance(t *testing.T) {
	p := &installProvider{instance: provider.Instance{State: "stopped"}}
	executor := NewWithReleaseResolver("", nil, resolverFunc(func(_ context.Context, platform, minecraftVersion string) (releaseArtifact, error) {
		return releaseArtifact{Platform: platform, MinecraftVersion: minecraftVersion, URL: "https://fill-data.papermc.io/v1/objects/test/server.jar", Name: "server.jar"}, nil
	}))
	err := executor.installServer(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{Args: map[string]any{
		"platform": "paper", "minecraft_version": "1.21.1", "target": "/server.jar", "accept_eula": false,
	}}, func(_, _, _ string, _ ...map[string]any) {})
	if err == nil || !strings.Contains(err.Error(), "explicitly agree") {
		t.Fatalf("expected explicit EULA consent error, got %v", err)
	}
	if p.started {
		t.Fatal("server must not start before explicit EULA acceptance")
	}
}

func TestInstallServerRequiresStoppedInstance(t *testing.T) {
	p := &installProvider{instance: provider.Instance{State: "running"}}
	executor := NewWithReleaseResolver("", nil, resolverFunc(func(context.Context, string, string) (releaseArtifact, error) {
		t.Fatal("resolver must not run for a live server")
		return releaseArtifact{}, nil
	}))
	err := executor.installServer(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{Args: map[string]any{
		"platform": "paper", "minecraft_version": "1.21.1", "target": "/server.jar",
	}}, func(_, _, _ string, _ ...map[string]any) {})
	if err == nil {
		t.Fatal("expected a running instance to be rejected")
	}
}

func TestExecuteStepStopsInstance(t *testing.T) {
	p := &installProvider{instance: provider.Instance{State: "running"}}
	executor := NewWithReleaseResolver(t.TempDir(), nil, nil)
	if err := executor.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{Tool: "instance.stop"}, func(_, _, _ string, _ ...map[string]any) {}); err != nil {
		t.Fatal(err)
	}
	if !p.stopped || p.instance.State != "stopped" {
		t.Fatalf("expected a normal stop request, got %#v", p)
	}
}
