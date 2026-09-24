package executor

import (
	"context"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

type playerInspectProvider struct {
	recoveryProvider
	output string
}

func (p *playerInspectProvider) ReadOutput(context.Context, string, int) (string, error) {
	return p.output, nil
}
func (p *playerInspectProvider) ReadFile(context.Context, string, string) ([]byte, error) {
	return []byte(p.output), nil
}
func (p *playerInspectProvider) SendCommand(_ context.Context, _ string, command string) error {
	p.commandCalls++
	switch command {
	case "list":
		p.output += "\nThere are 1 of a max of 20 players online: RiverFox"
	case "data get entity RiverFox playerGameType":
		p.output += "\nRiverFox has the following entity data: 2"
	default:
		p.output += "\nUnexpected command"
	}
	return nil
}

func TestPlayersInspectUsesBoundedConditionalRead(t *testing.T) {
	p := &playerInspectProvider{recoveryProvider: recoveryProvider{instance: provider.Instance{Ref: "mcs:daemon:instance", State: "running"}}}
	exec := New(t.TempDir(), nil)
	exec.consolePollDelay = 0
	var summary string
	err := exec.executeStep(context.Background(), p, protocol.TaskPlan{TaskID: "players-read", InstanceRef: p.instance.Ref}, protocol.TaskStep{
		ID: "s1", Tool: "players.inspect", Risk: "read",
		Args: map[string]any{"schema_version": "players-inspect/v1", "selector": "first-online", "fields": []any{"gamemode"}},
	}, func(_, kind, value string, _ ...map[string]any) {
		if kind == "players" {
			summary = value
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.commandCalls != 2 {
		t.Fatalf("expected two bounded console reads, got %d", p.commandCalls)
	}
	if !strings.Contains(summary, "online_count=1; selected=RiverFox; gamemode=adventure; condition=player-inspected") {
		t.Fatalf("unexpected summary: %s", summary)
	}
}

func TestPlayersInspectStopsAfterEmptyRoster(t *testing.T) {
	p := &playerInspectProvider{recoveryProvider: recoveryProvider{instance: provider.Instance{Ref: "mcs:daemon:instance", State: "running"}}}
	p.output = ""
	p.recoveryProvider.commandCalls = 0
	exec := New(t.TempDir(), nil)
	exec.consolePollDelay = 0
	// Replace the normal one-player response with an empty roster.
	p.output = "baseline"
	pSend := p.SendCommand
	_ = pSend
	// A dedicated provider makes the zero-player branch auditable without a second command.
	zero := &zeroPlayerInspectProvider{playerInspectProvider: *p}
	var summary string
	err := exec.executeStep(context.Background(), zero, protocol.TaskPlan{TaskID: "players-empty", InstanceRef: p.instance.Ref}, protocol.TaskStep{
		ID: "s1", Tool: "players.inspect", Risk: "read",
		Args: map[string]any{"schema_version": "players-inspect/v1", "selector": "first-online", "fields": []any{"gamemode"}},
	}, func(_, kind, value string, _ ...map[string]any) {
		if kind == "players" {
			summary = value
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if zero.commandCalls != 1 {
		t.Fatalf("zero-player branch must stop after list, got %d commands", zero.commandCalls)
	}
	if !strings.Contains(summary, "online_count=0; selected=<none>; gamemode=<none>; condition=no-online-players") {
		t.Fatalf("unexpected summary: %s", summary)
	}
}

type zeroPlayerInspectProvider struct{ playerInspectProvider }

func (p *zeroPlayerInspectProvider) SendCommand(_ context.Context, _ string, command string) error {
	p.commandCalls++
	if command == "list" {
		p.output += "\nThere are 0 of a max of 20 players online:"
	}
	return nil
}
