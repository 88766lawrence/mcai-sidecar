package executor

import (
	"reflect"
	"testing"

	"github.com/mcai/sidecar-agent/internal/provider"
)

func TestQA0144FilesListSuffixReturnsOnlyMatchingArtifacts(t *testing.T) {
	all := []string{
		".paper-remapped", "bStats", "LuckPerms", "ProtocolLib", "spark", "WorldEdit",
		"EssentialsX-2.22.0.jar", "LuckPerms-Bukkit-5.5.53.jar", "ProtocolLib.jar", "worldedit-bukkit-7.3.10-beta-01.jar",
	}
	result, err := filesListObservation(provider.FileListing{Names: all, Total: len(all)}, "plugins", ".jar")
	if err != nil {
		t.Fatal(err)
	}
	entries, ok := result["entries"].([]map[string]any)
	if !ok {
		t.Fatalf("unexpected entries type: %T", result["entries"])
	}
	got := make([]string, 0, len(entries))
	for _, entry := range entries {
		got = append(got, entry["name"].(string))
	}
	want := all[6:]
	if !reflect.DeepEqual(got, want) || result["total"] != 10 || result["filtered_count"] != 4 {
		t.Fatalf("unexpected filtered result: %#v", result)
	}
}
