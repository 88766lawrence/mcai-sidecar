package executor

import (
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

func TestWhitelistListRemainsReadOnly(t *testing.T) {
	step := protocol.TaskStep{Tool: "console.command", Args: map[string]any{"command": "whitelist list"}, Risk: "read"}
	command, risk, err := validateConsoleCommand(step)
	if err != nil || command != "whitelist list" || risk != "read" {
		t.Fatalf("expected canonical read-only whitelist query, got command=%q risk=%q err=%v", command, risk, err)
	}
}

func TestWhitelistEvidenceRequiresACompleteRosterLine(t *testing.T) {
	for _, incomplete := range []string{"whitelist list", "Command accepted", "whitelist"} {
		if consoleEvidenceComplete("whitelist", incomplete) {
			t.Fatalf("incomplete whitelist output was accepted: %q", incomplete)
		}
	}
	for _, complete := range []string{
		"There are no whitelisted players",
		"There are 2 whitelisted players: AuroraElm, FlintBay",
		"白名单中有 1 名玩家：青岚",
	} {
		if !consoleEvidenceComplete("whitelist", complete) {
			t.Fatalf("complete whitelist output was rejected: %q", complete)
		}
	}
}

func TestWhitelistMutationsCannotMasqueradeAsReads(t *testing.T) {
	for _, command := range []string{"whitelist add AuroraElm", "whitelist remove FlintBay", "whitelist off"} {
		step := protocol.TaskStep{Tool: "console.command", Args: map[string]any{"command": command}, Risk: "read"}
		if _, _, err := validateConsoleCommand(step); err == nil {
			t.Fatalf("mutation %q was accepted as read-only", command)
		}
	}
}
