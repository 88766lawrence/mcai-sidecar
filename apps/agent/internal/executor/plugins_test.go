package executor

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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

func TestOfficialPluginResolverFallsBackToVerifiedGitHubRelease(t *testing.T) {
	contents := []byte("official-essentialsx-release")
	digest := sha256.Sum256(contents)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/essentialsx/version":
			_, _ = writer.Write([]byte(`[]`))
		case "/repos/EssentialsX/Essentials/releases":
			_, _ = fmt.Fprintf(writer, `[{"id":2200,"tag_name":"2.22.0","body":"## Supported server versions\n- ✅ \u00601.21.11\u0060 - supported\n","draft":false,"prerelease":false,"assets":[{"name":"EssentialsX-2.22.0.jar","browser_download_url":%q,"digest":"sha256:%s"}]}]`, server.URL+"/EssentialsX-2.22.0.jar", hex.EncodeToString(digest[:]))
		case "/EssentialsX-2.22.0.jar":
			_, _ = writer.Write(contents)
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()

	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", githubBase: server.URL}
	artifact, err := resolver.Resolve(context.Background(), "essentialsx", "paper", "1.21.1")
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Source != "github-official" || artifact.VersionNumber != "2.22.0" || artifact.Compatibility != "official-release-train:1.21" {
		t.Fatalf("unexpected official fallback artifact: %#v", artifact)
	}
	if artifact.LocalSHA256 != hex.EncodeToString(digest[:]) || string(artifact.Contents) != string(contents) {
		t.Fatalf("official fallback did not preserve verified contents: %#v", artifact)
	}
}

func TestOfficialPluginResolverRejectsGitHubReleaseWithoutMatchingMinecraftTrain(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/essentialsx/version":
			_, _ = writer.Write([]byte(`[]`))
		case "/repos/EssentialsX/Essentials/releases":
			_, _ = writer.Write([]byte(`[{"id":2100,"tag_name":"2.21.0","body":"## Supported server versions\n- ✅ \u00601.20.6\u0060 - supported\n","draft":false,"prerelease":false,"assets":[]}]`))
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", githubBase: server.URL}
	if _, err := resolver.Resolve(context.Background(), "essentialsx", "paper", "1.21.1"); err == nil || !strings.Contains(err.Error(), "do not declare support") {
		t.Fatalf("expected release-train compatibility failure, got %v", err)
	}
}

func TestOfficialPluginResolverRejectsGitHubDigestMismatch(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/essentialsx/version":
			_, _ = writer.Write([]byte(`[]`))
		case "/repos/EssentialsX/Essentials/releases":
			_, _ = fmt.Fprintf(writer, `[{"id":2200,"tag_name":"2.22.0","body":"## Supported server versions\n- ✅ \u00601.21.11\u0060 - supported\n","draft":false,"prerelease":false,"assets":[{"name":"EssentialsX-2.22.0.jar","browser_download_url":%q,"digest":"sha256:%s"}]}]`, server.URL+"/EssentialsX-2.22.0.jar", strings.Repeat("0", 64))
		case "/EssentialsX-2.22.0.jar":
			_, _ = writer.Write([]byte("tampered"))
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", githubBase: server.URL}
	if _, err := resolver.Resolve(context.Background(), "essentialsx", "paper", "1.21.1"); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("expected GitHub SHA-256 mismatch, got %v", err)
	}
}

func TestLiveOfficialEssentialsXFallback(t *testing.T) {
	if os.Getenv("MCAI_LIVE_PLUGIN_RESOLVE") != "1" {
		t.Skip("set MCAI_LIVE_PLUGIN_RESOLVE=1 to query official plugin sources")
	}
	artifact, err := newOfficialPluginResolver().Resolve(context.Background(), "essentialsx", "paper", "1.21.1")
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Source != "github-official" || artifact.Project != "essentialsx" || !strings.HasSuffix(artifact.FileName, ".jar") {
		t.Fatalf("unexpected live official artifact: %#v", artifact)
	}
	if len(artifact.Contents) == 0 || len(artifact.LocalSHA256) != 64 || !strings.HasPrefix(artifact.Compatibility, "official-") {
		t.Fatalf("live official artifact was not verified: %#v", artifact)
	}
}

type staticPluginResolver struct{ artifact resolvedPlugin }

func (r staticPluginResolver) Resolve(context.Context, string, string, string) (resolvedPlugin, error) {
	return r.artifact, nil
}

type recordingPluginResolver struct {
	loader  string
	version string
}

func (r *recordingPluginResolver) Resolve(_ context.Context, _ string, loader string, version string) (resolvedPlugin, error) {
	r.loader, r.version = loader, version
	return resolvedPlugin{}, errors.New("recorded")
}

type pluginProvider struct {
	uploadDir  string
	uploadName string
	uploaded   []byte
	deleted    []string
	output     string
	listing    string
	latestLog  []byte
}

func (p *pluginProvider) ListInstances(context.Context) ([]provider.Instance, error) { return nil, nil }
func (p *pluginProvider) ReadOutput(context.Context, string, int) (string, error) {
	if p.output != "" {
		return p.output, nil
	}
	return "Server Plugins (1): Essentials", nil
}
func (p *pluginProvider) ListFiles(context.Context, string, string) (string, error) {
	if p.listing != "" {
		return p.listing, nil
	}
	return "共 1 项：" + p.uploadName, nil
}
func (p *pluginProvider) DownloadFromURL(context.Context, string, string, string) error { return nil }
func (p *pluginProvider) UpdateStartConfig(context.Context, string, provider.StartConfig) error {
	return nil
}
func (p *pluginProvider) ReadFile(context.Context, string, string) ([]byte, error) {
	return p.latestLog, nil
}
func (p *pluginProvider) WriteFile(context.Context, string, string, []byte) error { return nil }
func (p *pluginProvider) SendCommand(context.Context, string, string) error       { return nil }
func (p *pluginProvider) Start(context.Context, string) error                     { return nil }
func (p *pluginProvider) Stop(context.Context, string) error                      { return nil }
func (p *pluginProvider) Restart(context.Context, string) error                   { return nil }
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

func TestPluginResolveDetectsMissingServerMetadata(t *testing.T) {
	resolver := &recordingPluginResolver{}
	executor := New(t.TempDir(), nil)
	executor.pluginResolver = resolver
	provider := &pluginProvider{
		output:  "This server is running Paper version 1.21.1-133 (MC: 1.21.1)",
		listing: "共 4 项：plugins、config、bukkit.yml、spigot.yml",
	}
	err := executor.executeStep(context.Background(), provider, protocol.TaskPlan{
		TaskID: "task-detect-plugin", InstanceRef: "mcs:daemon:instance",
	}, protocol.TaskStep{Tool: "plugin.resolve", Args: map[string]any{
		"project": "essentialsx", "loader": "unknown", "minecraft_version": "",
	}}, func(string, string, string) {})
	if err == nil || err.Error() != "recorded" {
		t.Fatalf("expected recording resolver sentinel, got %v", err)
	}
	if resolver.loader != "paper" || resolver.version != "1.21.1" {
		t.Fatalf("detected target = %s %s, want paper 1.21.1", resolver.loader, resolver.version)
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
