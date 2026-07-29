package executor

import (
	"strings"
	"testing"
)

func TestPatchPropertiesPreservesComments(t *testing.T) {
	result, err := patchProperties([]byte("# server config\nview-distance=8\nmotd=Hello\n"), "view-distance", 10)
	if err != nil { t.Fatal(err) }
	text := string(result)
	if !strings.Contains(text, "# server config") || !strings.Contains(text, "view-distance=10") || !strings.Contains(text, "motd=Hello") { t.Fatalf("unexpected result: %s", text) }
}

