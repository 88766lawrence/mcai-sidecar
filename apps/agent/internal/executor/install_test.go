package executor

import (
	"context"
	"strings"
	"testing"

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
	}, func(_, kind, summary string) {
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
	}, func(_, _, _ string) {})
	if err == nil || !strings.Contains(err.Error(), "requires high risk") {
		t.Fatalf("expected high-risk rejection, got %v", err)
	}

	err = executor.executeStep(context.Background(), p, plan, protocol.TaskStep{
		Tool: "console.command", Args: map[string]any{"command": "op Steve"}, Risk: "high",
	}, func(_, _, _ string) {})
	if err == nil || !strings.Contains(err.Error(), "requires explicit confirmation") {
		t.Fatalf("expected confirmation rejection, got %v", err)
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
	}, func(_, kind, summary string) {
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
	}, func(_, _, _ string) {})
	if err == nil || !strings.Contains(err.Error(), "did not produce readable output") {
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

	if err := executor.installServer(context.Background(), p, plan, step, func(_, _, _ string) {}); err != nil {
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
	}}, func(_, _, _ string) {})
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
	}}, func(_, _, _ string) {})
	if err == nil {
		t.Fatal("expected a running instance to be rejected")
	}
}

func TestExecuteStepStopsInstance(t *testing.T) {
	p := &installProvider{instance: provider.Instance{State: "running"}}
	executor := NewWithReleaseResolver(t.TempDir(), nil, nil)
	if err := executor.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{Tool: "instance.stop"}, func(_, _, _ string) {}); err != nil {
		t.Fatal(err)
	}
	if !p.stopped || p.instance.State != "stopped" {
		t.Fatalf("expected a normal stop request, got %#v", p)
	}
}
