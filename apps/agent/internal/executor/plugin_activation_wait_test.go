package executor

import (
	"context"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

type stagedUpdateProvider struct {
	*installProvider
	ready bool
}

func (p *stagedUpdateProvider) ListFileEntries(_ context.Context, _ string, target string) (provider.FileListing, error) {
	if target == "/plugins/update" && !p.started {
		return provider.FileListing{Names: []string{"LuckPerms-Bukkit-5.5.71.jar"}, Total: 1}, nil
	}
	if target == "/plugins" && p.started {
		return provider.FileListing{Names: []string{"LuckPerms-Bukkit-5.5.71.jar"}, Total: 1}, nil
	}
	return provider.FileListing{Names: []string{}, Total: 0}, nil
}

func (p *stagedUpdateProvider) ReadOutput(context.Context, string, int) (string, error) {
	old := "[Server thread/INFO]: Done (20s)! For help, type \"help\"\n"
	if p.started && p.ready {
		return old + "Starting minecraft server version 1.21.1\n[Server thread/INFO]: Done (38s)! For help, type \"help\"", nil
	}
	return old, nil
}

func (p *stagedUpdateProvider) Start(context.Context, string) error {
	p.started = true
	p.instance.State = "running"
	return nil
}

func (p *stagedUpdateProvider) Restart(context.Context, string) error {
	p.started = true
	p.instance.State = "running"
	return nil
}

func TestStartWaitsForStagedPluginUpdateAndFreshReadySignal(t *testing.T) {
	p := &stagedUpdateProvider{installProvider: &installProvider{
		instance: provider.Instance{Ref: "mcs:daemon:instance", State: "stopped"},
	}, ready: true}
	exec := New(t.TempDir(), nil)
	var events []string
	err := exec.startInstance(context.Background(), p, p.instance.Ref, func(_, kind, summary string, _ ...map[string]any) {
		events = append(events, kind+"|"+summary)
	})
	if err != nil || !p.started || !strings.Contains(strings.Join(events, "\n"), "暂存插件已迁移") {
		t.Fatalf("staged plugin did not await fresh ready signal: err=%v events=%v", err, events)
	}
}

func TestStartDoesNotAcceptPreviousReadySignal(t *testing.T) {
	p := &stagedUpdateProvider{installProvider: &installProvider{
		instance: provider.Instance{Ref: "mcs:daemon:instance", State: "stopped"},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := New(t.TempDir(), nil).startInstance(ctx, p, p.instance.Ref, func(string, string, string, ...map[string]any) {})
	if err != context.Canceled {
		t.Fatalf("old ready signal was accepted: %v", err)
	}
}

func TestRestartWaitsForStagedPluginUpdate(t *testing.T) {
	p := &stagedUpdateProvider{installProvider: &installProvider{
		instance: provider.Instance{Ref: "mcs:daemon:instance", State: "running"},
	}, ready: true}
	exec := New(t.TempDir(), nil)
	var events []string
	err := exec.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: p.instance.Ref},
		protocol.TaskStep{Tool: "instance.restart"}, func(_, kind, summary string, _ ...map[string]any) {
			events = append(events, kind+"|"+summary)
		})
	if err != nil || !p.started || !strings.Contains(strings.Join(events, "\n"), "暂存插件已迁移") {
		t.Fatalf("restart did not await staged update: err=%v events=%v", err, events)
	}
}
