package executor

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

func TestOfficialPluginResolverVerifiesModrinthHash(t *testing.T) {
	contents := []byte("test-plugin-jar")
	sourceHash := sha512.Sum512(contents)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/essentialsx/version":
			writer.Header().Set("content-type", "application/json")
			_, _ = fmt.Fprintf(writer, `[{"id":"version-1","version_number":"2.21.0","dependencies":[],"files":[{"url":%q,"filename":"EssentialsX-2.21.0.jar","primary":true,"hashes":{"sha512":"%s"}}]}]`, server.URL+"/artifact.jar", hex.EncodeToString(sourceHash[:]))
		case "/artifact.jar":
			_, _ = writer.Write(contents)
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()

	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2"}
	artifact, err := resolver.Resolve(context.Background(), "essentialsx", "paper", "1.21.1")
	if err != nil {
		t.Fatal(err)
	}
	localHash := sha256.Sum256(contents)
	if artifact.FileName != "EssentialsX-2.21.0.jar" || artifact.LocalSHA256 != hex.EncodeToString(localHash[:]) {
		t.Fatalf("unexpected artifact: %#v", artifact)
	}
}

func TestOfficialPluginResolverRejectsHashMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/version") {
			_, _ = fmt.Fprintf(writer, `[{"id":"version-1","version_number":"1","dependencies":[],"files":[{"url":%q,"filename":"plugin.jar","primary":true,"hashes":{"sha512":"%s"}}]}]`, "http://"+request.Host+"/artifact.jar", strings.Repeat("0", 128))
			return
		}
		_, _ = writer.Write([]byte("tampered"))
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL}
	if _, err := resolver.Resolve(context.Background(), "example", "paper", "1.21.1"); err == nil || !strings.Contains(err.Error(), "SHA-512") {
		t.Fatalf("expected SHA-512 mismatch, got %v", err)
	}
}

type staticPluginResolver struct{ artifact resolvedPlugin }

func (r staticPluginResolver) Resolve(context.Context, string, string, string) (resolvedPlugin, error) {
	return r.artifact, nil
}

type pluginProvider struct {
	uploadDir  string
	uploadName string
	uploaded   []byte
	deleted    []string
}

func (p *pluginProvider) ListInstances(context.Context) ([]provider.Instance, error) { return nil, nil }
func (p *pluginProvider) ReadOutput(context.Context, string, int) (string, error) {
	return "Server Plugins (1): Essentials", nil
}
func (p *pluginProvider) ListFiles(context.Context, string, string) (string, error) {
	return "共 1 项：" + p.uploadName, nil
}
func (p *pluginProvider) DownloadFromURL(context.Context, string, string, string) error { return nil }
func (p *pluginProvider) UpdateStartConfig(context.Context, string, provider.StartConfig) error {
	return nil
}
func (p *pluginProvider) ReadFile(context.Context, string, string) ([]byte, error) { return nil, nil }
func (p *pluginProvider) WriteFile(context.Context, string, string, []byte) error  { return nil }
func (p *pluginProvider) SendCommand(context.Context, string, string) error        { return nil }
func (p *pluginProvider) Start(context.Context, string) error                      { return nil }
func (p *pluginProvider) Stop(context.Context, string) error                       { return nil }
func (p *pluginProvider) Restart(context.Context, string) error                    { return nil }
func (p *pluginProvider) GetInstance(context.Context, string) (provider.Instance, error) {
	return provider.Instance{State: "running"}, nil
}
func (p *pluginProvider) UploadFile(_ context.Context, _ string, directory, name string, contents []byte) error {
	p.uploadDir, p.uploadName, p.uploaded = directory, name, append([]byte(nil), contents...)
	return nil
}
func (p *pluginProvider) DeleteFiles(_ context.Context, _ string, targets []string) error {
	p.deleted = append([]string(nil), targets...)
	return nil
}

func TestPluginResolveInstallAndRollback(t *testing.T) {
	contents := []byte("verified-plugin")
	hash256 := sha256.Sum256(contents)
	hash512 := sha512.Sum512(contents)
	executor := New(t.TempDir(), nil)
	executor.pluginResolver = staticPluginResolver{artifact: resolvedPlugin{
		Project: "essentialsx", VersionID: "version-1", VersionNumber: "2.21.0",
		FileName: "EssentialsX-2.21.0.jar", SourceURL: "https://cdn.modrinth.com/data/test.jar",
		SourceSHA512: hex.EncodeToString(hash512[:]), LocalSHA256: hex.EncodeToString(hash256[:]), Contents: contents,
	}}
	plan := protocol.TaskPlan{TaskID: "task-plugin", InstanceRef: "mcs:daemon:instance"}
	provider := &pluginProvider{}
	if err := executor.executeStep(context.Background(), provider, plan, protocol.TaskStep{Tool: "plugin.resolve", Args: map[string]any{
		"project": "essentialsx", "loader": "paper", "minecraft_version": "1.21.1",
	}}, func(string, string, string) {}); err != nil {
		t.Fatal(err)
	}
	if err := executor.executeStep(context.Background(), provider, plan, protocol.TaskStep{Tool: "plugin.install", Args: map[string]any{
		"project": "essentialsx", "expected_sha256": "${s1.sha256}",
	}}, func(string, string, string) {}); err != nil {
		t.Fatal(err)
	}
	if provider.uploadDir != "plugins" || provider.uploadName != "EssentialsX-2.21.0.jar" || string(provider.uploaded) != string(contents) {
		t.Fatalf("unexpected controlled upload: %#v", provider)
	}
	executor.rollbackPlugin(context.Background(), provider, plan, func(string, string, string) {})
	if len(provider.deleted) != 1 || provider.deleted[0] != "plugins/EssentialsX-2.21.0.jar" {
		t.Fatalf("unexpected rollback targets: %#v", provider.deleted)
	}
}

func TestPluginAcceptanceRecognizesEssentialsAlias(t *testing.T) {
	if !containsPluginEvidence("Server Plugins (1): Essentials", "essentialsx") {
		t.Fatal("expected Essentials console evidence to satisfy EssentialsX acceptance")
	}
	if containsPluginEvidence("Server Plugins (0):", "essentialsx") {
		t.Fatal("empty plugin list must not pass acceptance")
	}
}
