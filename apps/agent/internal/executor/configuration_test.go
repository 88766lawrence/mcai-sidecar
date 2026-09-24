package executor

import (
	"encoding/json"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestPatchYAMLNestedPluginConfiguration(t *testing.T) {
	input := []byte("# plugin settings\nwelcome:\n  enabled: false\n  message: old\n")
	updated, err := patchConfiguration(input, "/plugins/Lobby/config.yml", "welcome.message", "欢迎来到服务器")
	if err != nil {
		t.Fatal(err)
	}
	updated, err = patchConfiguration(updated, "/plugins/Lobby/config.yml", "welcome.enabled", true)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := yaml.Unmarshal(updated, &parsed); err != nil {
		t.Fatal(err)
	}
	welcome := parsed["welcome"].(map[string]any)
	if welcome["message"] != "欢迎来到服务器" || welcome["enabled"] != true {
		t.Fatalf("unexpected YAML result: %s", updated)
	}
	if !strings.Contains(string(updated), "# plugin settings") {
		t.Fatalf("top-level YAML comment was not preserved: %s", updated)
	}
}

func TestPatchJSONCreatesNestedConfiguration(t *testing.T) {
	updated, err := patchConfiguration([]byte(`{"locale":"en"}`), "/plugins/Example/config.json", "welcome.initial-balance", 1000)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(updated, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["welcome"].(map[string]any)["initial-balance"] != float64(1000) {
		t.Fatalf("unexpected JSON result: %s", updated)
	}
}

func TestPatchConfigurationRejectsCrossingScalar(t *testing.T) {
	_, err := patchConfiguration([]byte("welcome: disabled\n"), "/plugins/Example/config.yml", "welcome.message", "hello")
	if err == nil || !strings.Contains(err.Error(), "non-mapping") {
		t.Fatalf("expected scalar traversal rejection, got %v", err)
	}
}

func TestSanitizeConfigurationRedactsCredentials(t *testing.T) {
	value := sanitizeConfiguration([]byte("locale: zh_CN\napi-key: secret-value\npassword=private\nenabled: true\n"))
	if strings.Contains(value, "secret-value") || strings.Contains(value, "private") {
		t.Fatalf("configuration sanitizer leaked credentials: %s", value)
	}
	if !strings.Contains(value, "locale: zh_CN") || !strings.Contains(value, "enabled: true") {
		t.Fatalf("configuration sanitizer removed safe context: %s", value)
	}
}

func TestSelectConfigurationKeysFromPropertiesAndYAML(t *testing.T) {
	properties := selectConfigurationKeys([]byte("motd=Welcome\nonline-mode=true\nmax-players=20\n"), "server.properties", []string{"online-mode", "motd", "missing"})
	if properties != "online-mode=true\nmotd=Welcome\nmissing=<MISSING>" {
		t.Fatalf("unexpected properties projection: %q", properties)
	}
	yamlValue := selectConfigurationKeys([]byte("proxies:\n  velocity:\n    enabled: true\nlocale: zh_CN\n"), "config/paper.yml", []string{"proxies.velocity.enabled", "locale"})
	if yamlValue != "proxies.velocity.enabled=true\nlocale=zh_CN" {
		t.Fatalf("unexpected YAML projection: %q", yamlValue)
	}
}
