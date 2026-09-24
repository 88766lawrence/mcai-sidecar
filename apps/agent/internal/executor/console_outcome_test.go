package executor

import "testing"

func TestConsoleCommandOutcomeVectors(t *testing.T) {
	tests := []struct {
		name, output, status, code string
	}{
		{"zero player target", "No players were found", "rejected", "NO_TARGETS"},
		{"zero entity target", "Selector @e found no entities", "rejected", "NO_TARGETS"},
		{"localized zero target", "没有找到任何玩家", "rejected", "NO_TARGETS"},
		{"invalid syntax", "Unknown or incomplete command, see below", "rejected", "INVALID_COMMAND"},
		{"permission denial", "You do not have permission to use this command", "rejected", "PERMISSION_DENIED"},
		{"execution exception", "An unexpected error occurred trying to execute that command", "rejected", "EXECUTION_ERROR"},
		{"explicit success", "Set the time to 6000", "applied", "EXPLICIT_SUCCESS"},
		{"ordinary say echo", "[Server] Maintenance begins shortly", "applied", "EXPLICIT_SUCCESS"},
		{"empty callback", "  ", "indeterminate", "EMPTY_CALLBACK"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			outcome := ClassifyConsoleCommandOutcome(test.output)
			if outcome.SchemaVersion != "console-command-outcome/v1" || outcome.Status != test.status || outcome.Code != test.code || outcome.OutputSHA256 == "" {
				t.Fatalf("unexpected outcome: %#v", outcome)
			}
		})
	}
}

func TestStrictConsoleCommandOutcomeRejectsIncompleteOrUnclassifiedFrames(t *testing.T) {
	tests := []string{
		"t",
		"No pla",
		"Displayed mess",
		"\ufffd",
		"arbitrary transport fragment",
	}
	for _, output := range tests {
		outcome := ClassifyConsoleCommandOutcome(output, true)
		if outcome.Status != "indeterminate" || outcome.Code != "INCOMPLETE_CALLBACK" {
			t.Fatalf("strict output %q was accepted: %#v", output, outcome)
		}
	}
	invalidUTF8 := string([]byte{0xe4, 0xb8})
	if outcome := ClassifyConsoleCommandOutcome(invalidUTF8, true); outcome.Status != "indeterminate" || outcome.Code != "INCOMPLETE_CALLBACK" {
		t.Fatalf("partial UTF-8 callback was accepted: %#v", outcome)
	}
	for _, output := range []string{
		"Displayed message to 3 players",
		"[Server] Tournament registration is open",
	} {
		outcome := ClassifyConsoleCommandOutcome(output, true)
		if outcome.Status != "applied" || outcome.Code != "EXPLICIT_SUCCESS" {
			t.Fatalf("explicit success %q was not accepted: %#v", output, outcome)
		}
	}
}

func TestGuardedAudienceConditionMapsOnlyItsOwnFailureToNoTargets(t *testing.T) {
	command := "execute if entity @a run execute as @a at @s run particle minecraft:happy_villager ~ ~1 ~ 0.25 0.25 0.25 0 5 force @s"
	if !consoleEvidenceComplete(command, "Test failed", true) {
		t.Fatal("guarded audience failure did not complete the callback window")
	}
	outcome := ClassifyConsoleCommandOutcomeForCommand(command, "Test failed", true)
	if outcome.Status != "rejected" || outcome.Code != "NO_TARGETS" {
		t.Fatalf("guarded zero-target condition was not classified: %#v", outcome)
	}
	withoutCommand := ClassifyConsoleCommandOutcome("Test failed", true)
	if withoutCommand.Status != "indeterminate" || withoutCommand.Code != "INCOMPLETE_CALLBACK" {
		t.Fatalf("unbound failed condition was trusted: %#v", withoutCommand)
	}
}

func TestConsoleEvidenceIgnoresCommandEchoUntilBusinessOutcome(t *testing.T) {
	if consoleEvidenceComplete("title", `> title @a actionbar {"text":"Arena opens soon"}`) {
		t.Fatal("command echo was accepted as an actionbar business outcome")
	}
	if consoleEvidenceComplete("title", `[Server thread/INFO]: Operator issued server command: /title @a actionbar {"text":"Arena opens soon"}`) {
		t.Fatal("issued-command audit line was accepted as an actionbar business outcome")
	}
	if !consoleEvidenceComplete("title", "> title @a actionbar test\nNo player was found") {
		t.Fatal("zero-target actionbar result did not complete the console wait")
	}
	if !consoleEvidenceComplete("say", "> say Arena opens soon\n[Server] Arena opens soon") {
		t.Fatal("real say broadcast did not complete the console wait")
	}
}
