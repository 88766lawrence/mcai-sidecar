package executor

import (
	"context"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

func TestParseGameruleReadResult(t *testing.T) {
	tests := []struct {
		name, rule, output, want string
		ok                       bool
	}{
		{"boolean", "doMobLoot", "[Server thread/INFO]: Gamerule doMobLoot is currently set to: false", "false", true},
		{"numeric zero", "randomTickSpeed", "Gamerule randomTickSpeed is currently set to: 0", "0", true},
		{"string", "reducedDebugInfo", "The value of gamerule reducedDebugInfo is true", "true", true},
		{"echo", "doMobLoot", "> gamerule doMobLoot", "", false},
		{"wrong rule", "doMobLoot", "Gamerule keepInventory is currently set to: false", "", false},
		{"truncated", "doMobLoot", "Gamerule doMobLoot is currently set to:", "", false},
		{"conflict", "doMobLoot", "Gamerule doMobLoot is currently set to: false\nGamerule doMobLoot is currently set to: true", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseGameruleReadResult(tt.rule, tt.output)
			if (err == nil) != tt.ok || got != tt.want {
				t.Fatalf("got %q err=%v", got, err)
			}
		})
	}
}

func TestGameruleGetterEmitsBoundStructuredEvidence(t *testing.T) {
	p := &installProvider{
		instance:     provider.Instance{State: "running"},
		outputBefore: "[Server thread/INFO]: previous\n",
		outputAfter:  "[Server thread/INFO]: previous\n[Server thread/INFO]: Gamerule doMobLoot is currently set to: false\n",
	}
	e := NewWithReleaseResolver("", nil, nil)
	var evidence string
	err := e.executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{
		Tool: "console.command", Args: map[string]any{"command": "gamerule doMobLoot"}, Risk: "read",
	}, func(_, kind, summary string, _ ...map[string]any) {
		if kind == "console" {
			evidence = summary
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.commands) != 1 || p.commands[0] != "gamerule doMobLoot" {
		t.Fatalf("commands=%#v", p.commands)
	}
	if !strings.Contains(evidence, "Gamerule read result: rule=doMobLoot; value=false") {
		t.Fatalf("evidence=%q", evidence)
	}

	bad := &installProvider{
		instance: provider.Instance{State: "running"}, outputBefore: "old\n",
		outputAfter: "old\n[Server thread/INFO]: Gamerule keepInventory is currently set to: false\n",
	}
	if err := e.executeStep(context.Background(), bad, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{
		Tool: "console.command", Args: map[string]any{"command": "gamerule doMobLoot"}, Risk: "read",
	}, func(_, _, _ string, _ ...map[string]any) {}); err == nil {
		t.Fatal("wrong-rule callback was accepted")
	}
}
