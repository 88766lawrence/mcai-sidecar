package executor

import (
	"strings"
	"testing"
)

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
