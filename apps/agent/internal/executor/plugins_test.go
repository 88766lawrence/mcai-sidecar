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
	artifact, err := resolver.Resolve(context.Background(), "essentialsx", "paper", "1.21.1", nil)
	if err != nil {
		t.Fatal(err)
	}
	localHash := sha256.Sum256(contents)
	if artifact.FileName != "EssentialsX-2.21.0.jar" || artifact.LocalSHA256 != hex.EncodeToString(localHash[:]) {
		t.Fatalf("unexpected artifact: %#v", artifact)
	}
}

func TestOfficialPluginMetadataResolutionDoesNotDownloadArtifact(t *testing.T) {
	contents := []byte("metadata-only-plugin")
	sourceHash := sha512.Sum512(contents)
	artifactRequests := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/metadataonly/version":
			_, _ = fmt.Fprintf(writer, `[{"id":"version-meta","version_number":"4.2.0","dependencies":[],"files":[{"url":%q,"filename":"MetadataOnly-4.2.0.jar","primary":true,"hashes":{"sha512":"%s"}}]}]`, server.URL+"/artifact.jar", hex.EncodeToString(sourceHash[:]))
		case "/artifact.jar":
			artifactRequests++
			_, _ = writer.Write(contents)
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()

	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2"}
	artifact, err := resolver.ResolveMetadata(context.Background(), "metadataonly", "paper", "1.21.3", nil)
	if err != nil {
		t.Fatal(err)
	}
	if artifactRequests != 0 || len(artifact.Contents) != 0 || artifact.LocalSHA256 != "" {
		t.Fatalf("metadata lookup downloaded artifact bytes: requests=%d artifact=%#v", artifactRequests, artifact)
	}
	if artifact.Source != "modrinth" || artifact.SourceSHA512 != hex.EncodeToString(sourceHash[:]) || artifact.Compatibility == "" {
		t.Fatalf("metadata lookup omitted provenance, integrity, or compatibility: %#v", artifact)
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
	if _, err := resolver.Resolve(context.Background(), "example", "paper", "1.21.1", nil); err == nil || !strings.Contains(err.Error(), "SHA-512") {
		t.Fatalf("expected SHA-512 mismatch, got %v", err)
	}
}

func TestOfficialPluginResolverStopsOnModrinthInfrastructureFailure(t *testing.T) {
	hangarCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/v2/project/") {
			writer.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		hangarCalls++
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", hangarBase: server.URL + "/api/v1", githubBase: server.URL}
	var progress []string
	_, err := resolver.ResolveMetadata(context.Background(), "essentialsx", "paper", "1.21.1", func(source, status string) {
		progress = append(progress, source+":"+status)
	})
	if err == nil || !strings.Contains(err.Error(), "HTTP 503") || errors.Is(err, errNoCompatiblePluginVersion) || hangarCalls != 0 {
		t.Fatalf("infrastructure failure must stop fallback: err=%v hangarCalls=%d", err, hangarCalls)
	}
	if strings.Contains(strings.Join(progress, "\n"), "Hangar:") {
		t.Fatalf("progress must not claim Hangar was queried: %#v", progress)
	}
}

func TestOfficialPluginResolverStopsOnHangarInfrastructureFailure(t *testing.T) {
	githubCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasPrefix(request.URL.Path, "/v2/project/"):
			_, _ = writer.Write([]byte(`[]`))
		case strings.HasPrefix(request.URL.Path, "/api/v1/"):
			writer.WriteHeader(http.StatusServiceUnavailable)
		default:
			githubCalls++
			writer.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", hangarBase: server.URL + "/api/v1", githubBase: server.URL}
	_, err := resolver.ResolveMetadata(context.Background(), "essentialsx", "paper", "1.21.1", nil)
	if err == nil || !strings.Contains(err.Error(), "HTTP 503") || errors.Is(err, errNoCompatiblePluginVersion) || githubCalls != 0 {
		t.Fatalf("Hangar failure must not become absence or trigger GitHub: err=%v githubCalls=%d", err, githubCalls)
	}
}

func TestOfficialPluginResolverPreservesGitHubInfrastructureFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/v2/project/") {
			_, _ = writer.Write([]byte(`[]`))
			return
		}
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", githubBase: server.URL}
	_, err := resolver.ResolveMetadata(context.Background(), "essentialsx", "paper", "1.21.1", nil)
	if err == nil || !strings.Contains(err.Error(), "HTTP 503") || errors.Is(err, errNoCompatiblePluginVersion) {
		t.Fatalf("GitHub failure must not become no-compatible-artifact: %v", err)
	}
}

func TestOfficialPluginResolverFallsBackToVerifiedHangarRelease(t *testing.T) {
	contents := []byte("placeholderapi-hangar-release")
	digest := sha256.Sum256(contents)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/placeholderapi/version":
			writer.WriteHeader(http.StatusNotFound)
		case "/api/v1/projects/PlaceholderAPI/versions":
			_, _ = fmt.Fprintf(writer, `{"pagination":{"count":1,"limit":25,"offset":0},"result":[{"id":22698,"name":"2.12.2","visibility":"public","reviewState":"reviewed","channel":{"name":"Release"},"downloads":{"PAPER":{"fileInfo":{"name":"PlaceholderAPI-2.12.2.jar","sizeBytes":%d,"sha256Hash":"%s"},"externalUrl":"","downloadUrl":%q}},"pluginDependencies":{},"platformDependencies":{"PAPER":["1.21.1"]}}]}`, len(contents), hex.EncodeToString(digest[:]), server.URL+"/artifact.jar")
		case "/artifact.jar":
			_, _ = writer.Write(contents)
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()

	resolver := &officialPluginResolver{
		httpClient: server.Client(), apiBase: server.URL + "/v2", hangarBase: server.URL + "/api/v1",
	}
	var progress []string
	artifact, err := resolver.Resolve(context.Background(), "placeholderapi", "paper", "1.21.1", func(source, status string) {
		progress = append(progress, source+":"+status)
	})
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Source != "hangar" || artifact.Project != "placeholderapi" || artifact.VersionNumber != "2.12.2" {
		t.Fatalf("unexpected Hangar artifact: %#v", artifact)
	}
	if artifact.LocalSHA256 != hex.EncodeToString(digest[:]) || string(artifact.Contents) != string(contents) {
		t.Fatalf("Hangar artifact was not verified: %#v", artifact)
	}
	if len(progress) < 4 || !strings.HasPrefix(progress[0], "Modrinth:") || !strings.Contains(strings.Join(progress, "\n"), "Hangar:已找到") {
		t.Fatalf("missing multi-source progress: %#v", progress)
	}
}

func TestOfficialPluginResolverRejectsHangarDependencyWithoutApproval(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/example/version":
			_, _ = writer.Write([]byte(`[]`))
		case "/api/v1/projects":
			_, _ = writer.Write([]byte(`{"result":[{"name":"example","visibility":"public","namespace":{"slug":"example"},"supportedPlatforms":{"PAPER":["1.21.1"]}}]}`))
		case "/api/v1/projects/example/versions":
			_, _ = writer.Write([]byte(`{"result":[{"id":1,"name":"1.0.0","visibility":"public","channel":{"name":"Release"},"downloads":{"PAPER":{}},"pluginDependencies":{"PAPER":[{"name":"RequiredPlugin","required":true}]},"platformDependencies":{"PAPER":["1.21.1"]}}]}`))
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", hangarBase: server.URL + "/api/v1"}
	_, err := resolver.Resolve(context.Background(), "example", "paper", "1.21.1", nil)
	if err == nil || !strings.Contains(err.Error(), "separate approval") {
		t.Fatalf("expected dependency approval failure, got %v", err)
	}
}

func TestOfficialPluginResolverSkipsIncompatibleHangarDependenciesAndAllowsOptionalOnes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/placeholderapi/version":
			_, _ = writer.Write([]byte(`[]`))
		case "/api/v1/projects/PlaceholderAPI/versions":
			_, _ = fmt.Fprintf(writer, `{"result":[
				{"id":2,"name":"2.0.0","visibility":"public","channel":{"name":"Release"},"downloads":{"PAPER":{}},"pluginDependencies":{"PAPER":[{"name":"OtherPlugin","required":true}]},"platformDependencies":{"PAPER":["1.21.11"]}},
				{"id":1,"name":"1.0.0","visibility":"public","channel":{"name":"Release"},"downloads":{"PAPER":{"fileInfo":{"name":"PlaceholderAPI-1.0.0.jar","sizeBytes":1024,"sha256Hash":"%s"},"downloadUrl":"https://hangarcdn.papermc.io/test.jar"}},"pluginDependencies":{"PAPER":[{"name":"Vault","required":false}]},"platformDependencies":{"PAPER":["1.21.1"]}}
			]}`, strings.Repeat("0", 64))
		default:
			t.Fatalf("unexpected request %s", request.URL.Path)
		}
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", hangarBase: server.URL + "/api/v1"}
	artifact, err := resolver.ResolveMetadata(context.Background(), "placeholderapi", "paper", "1.21.1", nil)
	if err != nil || artifact.Source != "hangar" || artifact.VersionNumber != "1.0.0" || len(artifact.Contents) != 0 {
		t.Fatalf("expected compatible release with optional dependency, got %+v, %v", artifact, err)
	}
}

func TestHangarDiscoverySelectsOnlyExactCompatibleProject(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/projects" || request.URL.Query().Get("query") != "vault" {
			t.Fatalf("unexpected request %s", request.URL.String())
		}
		_, _ = writer.Write([]byte(`{"result":[
			{"name":"VaultTaxesWithGUI","visibility":"public","namespace":{"slug":"VaultTaxesWithGUI"},"supportedPlatforms":{"PAPER":["1.21.1"]}},
			{"name":"Vault","visibility":"public","namespace":{"slug":"Vault"},"supportedPlatforms":{"PAPER":["1.20.6"]}},
			{"name":"Vault","visibility":"public","namespace":{"slug":"VaultModern"},"supportedPlatforms":{"PAPER":["1.21.1"]}}
		]}`))
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), hangarBase: server.URL + "/api/v1"}
	discovered, err := resolver.findExactHangarProject(context.Background(), "vault", "1.21.1")
	if err != nil {
		t.Fatal(err)
	}
	if discovered != "VaultModern" {
		t.Fatalf("discovered %q, want exact compatible Vault project", discovered)
	}
}

func TestReviewedHangarGitHubExternalAssetRequiresMatchingDigest(t *testing.T) {
	contents := []byte("reviewed-hangar-github-asset")
	digest := sha256.Sum256(contents)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/protocollib/version":
			writer.WriteHeader(http.StatusNotFound)
		case "/api/v1/projects":
			_, _ = writer.Write([]byte(`{"result":[{"name":"ProtocolLib","visibility":"public","namespace":{"slug":"ProtocolLib"},"supportedPlatforms":{"PAPER":["1.21.1"]}}]}`))
		case "/api/v1/projects/ProtocolLib/versions":
			_, _ = writer.Write([]byte(`{"result":[{"id":54,"name":"5.4.0","visibility":"public","reviewState":"reviewed","channel":{"name":"Release"},"downloads":{"PAPER":{"fileInfo":null,"externalUrl":"https://github.com/dmulloy2/ProtocolLib/releases/download/5.4.0/ProtocolLib.jar","downloadUrl":null}},"pluginDependencies":{},"platformDependencies":{"PAPER":["1.21.1"]}}]}`))
		case "/repos/dmulloy2/ProtocolLib/releases/tags/5.4.0":
			_, _ = fmt.Fprintf(writer, `{"draft":false,"prerelease":false,"assets":[{"name":"ProtocolLib.jar","browser_download_url":"https://github.com/dmulloy2/ProtocolLib/releases/download/5.4.0/ProtocolLib.jar","digest":"sha256:%s","size":%d}]}`, hex.EncodeToString(digest[:]), len(contents))
		case "/external/ProtocolLib.jar":
			_, _ = writer.Write(contents)
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", hangarBase: server.URL + "/api/v1", githubBase: server.URL}
	// Test servers cannot own github.com; redirect the exact trusted URL to the
	// local artifact while preserving the URL checked in both metadata sources.
	resolver.httpClient.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Hostname() == "github.com" {
			request.URL.Scheme = "http"
			request.URL.Host = strings.TrimPrefix(server.URL, "http://")
			request.URL.Path = "/external/ProtocolLib.jar"
		}
		return http.DefaultTransport.RoundTrip(request)
	})
	artifact, err := resolver.Resolve(context.Background(), "protocollib", "paper", "1.21.1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Source != "hangar-reviewed-github" || artifact.LocalSHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("unexpected reviewed external artifact: source=%q hash=%q", artifact.Source, artifact.LocalSHA256)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
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
	artifact, err := resolver.Resolve(context.Background(), "essentialsx", "paper", "1.21.1", nil)
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
	if _, err := resolver.Resolve(context.Background(), "essentialsx", "paper", "1.21.1", nil); err == nil || !strings.Contains(err.Error(), "do not declare support") {
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
	if _, err := resolver.Resolve(context.Background(), "essentialsx", "paper", "1.21.1", nil); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("expected GitHub SHA-256 mismatch, got %v", err)
	}
}

func TestLiveOfficialEssentialsXFallback(t *testing.T) {
	if os.Getenv("MCAI_LIVE_PLUGIN_RESOLVE") != "1" {
		t.Skip("set MCAI_LIVE_PLUGIN_RESOLVE=1 to query official plugin sources")
	}
	artifact, err := newOfficialPluginResolver().Resolve(context.Background(), "essentialsx", "paper", "1.21.1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if (artifact.Source != "hangar" && artifact.Source != "github-official") || artifact.Project != "essentialsx" || !strings.HasSuffix(artifact.FileName, ".jar") {
		t.Fatalf("unexpected live official artifact: %#v", artifact)
	}
	if len(artifact.Contents) == 0 || len(artifact.LocalSHA256) != 64 || artifact.Compatibility == "" {
		t.Fatalf("live official artifact was not verified: %#v", artifact)
	}
}

func TestLiveMultipleNonModrinthPluginSources(t *testing.T) {
	if os.Getenv("MCAI_LIVE_PLUGIN_RESOLVE") != "1" {
		t.Skip("set MCAI_LIVE_PLUGIN_RESOLVE=1 to query official plugin sources")
	}
	// EssentialsX is covered by TestLiveOfficialEssentialsXFallback above.
	// ProtocolLib is intentionally resolved by name here: it is absent from
	// Modrinth, so this also exercises exact Hangar project discovery.
	for _, project := range []string{"protocollib"} {
		t.Run(project, func(t *testing.T) {
			var progress []string
			artifact, err := newOfficialPluginResolver().Resolve(context.Background(), project, "paper", "1.21.1", func(source, status string) {
				progress = append(progress, source+":"+status)
			})
			if err != nil {
				t.Fatal(err)
			}
			if artifact.Project != project || artifact.Source != "hangar-reviewed-github" || len(artifact.LocalSHA256) != 64 || len(artifact.Contents) == 0 {
				t.Fatalf("unexpected verified artifact: project=%q source=%q version=%q file=%q hash_length=%d size=%d", artifact.Project, artifact.Source, artifact.VersionNumber, artifact.FileName, len(artifact.LocalSHA256), len(artifact.Contents))
			}
			if !strings.Contains(strings.Join(progress, "\n"), "Modrinth:") || !strings.Contains(strings.Join(progress, "\n"), "Hangar:") {
				t.Fatalf("source fallback was not observable: %#v", progress)
			}
		})
	}
}

type staticPluginResolver struct{ artifact resolvedPlugin }

func (r staticPluginResolver) Resolve(context.Context, string, string, string, pluginResolutionProgress) (resolvedPlugin, error) {
	return r.artifact, nil
}

type failingPluginResolver struct{ err error }

func (r failingPluginResolver) Resolve(context.Context, string, string, string, pluginResolutionProgress) (resolvedPlugin, error) {
	return resolvedPlugin{}, r.err
}

type recordingPluginResolver struct {
	loader  string
	version string
}

func (r *recordingPluginResolver) Resolve(_ context.Context, _ string, loader string, version string, _ pluginResolutionProgress) (resolvedPlugin, error) {
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
		Source: "modrinth", Compatibility: "paper 1.21.1",
	}}
	resolvePlan := protocol.TaskPlan{TaskID: "task-plugin-resolve", InstanceRef: "mcs:daemon:instance"}
	installPlan := protocol.TaskPlan{TaskID: "task-plugin-install", InstanceRef: "mcs:daemon:instance"}
	provider := &pluginProvider{}
	var resolveSummary string
	if err := executor.executeStep(context.Background(), provider, resolvePlan, protocol.TaskStep{Tool: "plugin.resolve", Args: map[string]any{
		"project": "essentialsx", "loader": "paper", "minecraft_version": "1.21.1",
	}}, func(_ string, kind string, summary string, _ ...map[string]any) {
		if kind == "plugin" {
			resolveSummary = summary
		}
	}); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"Plugin resolve result:", "project=essentialsx", "version=2.21.0", "source=", "artifact=EssentialsX-2.21.0.jar", "compatibility=", "sha256="} {
		if !strings.Contains(resolveSummary, required) {
			t.Fatalf("resolve evidence omitted %q: %s", required, resolveSummary)
		}
	}
	if err := executor.executeStep(context.Background(), provider, installPlan, protocol.TaskStep{Tool: "plugin.install", Args: map[string]any{
		"project": "essentialsx", "expected_integrity": map[string]any{"algorithm": "sha256", "value": hex.EncodeToString(hash256[:])}, "source_task_id": resolvePlan.TaskID,
	}}, func(string, string, string, ...map[string]any) {}); err != nil {
		t.Fatal(err)
	}
	if provider.uploadDir != "plugins" || provider.uploadName != "EssentialsX-2.21.0.jar" || string(provider.uploaded) != string(contents) {
		t.Fatalf("unexpected controlled upload: %#v", provider)
	}
	executor.rollbackPlugin(context.Background(), provider, installPlan, func(string, string, string, ...map[string]any) {})
	if len(provider.deleted) != 1 || provider.deleted[0] != "plugins/EssentialsX-2.21.0.jar" {
		t.Fatalf("unexpected rollback targets: %#v", provider.deleted)
	}
}

func TestPluginMetadataOnlyResolveFetchesVerifiedArtifactDuringInstall(t *testing.T) {
	contents := []byte("metadata-only-install")
	hash512 := sha512.Sum512(contents)
	artifactRequests := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/project/authmereloaded/version":
			writer.Header().Set("content-type", "application/json")
			_, _ = fmt.Fprintf(writer, `[{"id":"version-authme","version_number":"5.7.0","dependencies":[],"files":[{"url":%q,"filename":"AuthMe-5.7.0.jar","primary":true,"hashes":{"sha512":"%s"}}]}]`, server.URL+"/AuthMe-5.7.0.jar", hex.EncodeToString(hash512[:]))
		case "/AuthMe-5.7.0.jar":
			artifactRequests++
			_, _ = writer.Write(contents)
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()

	executor := New(t.TempDir(), nil)
	executor.pluginResolver = &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2"}
	resolvePlan := protocol.TaskPlan{TaskID: "task-authme-resolve", InstanceRef: "mcs:daemon:instance"}
	installPlan := protocol.TaskPlan{TaskID: "task-authme-install", InstanceRef: "mcs:daemon:instance"}
	provider := &pluginProvider{}
	if err := executor.executeStep(context.Background(), provider, resolvePlan, protocol.TaskStep{Tool: "plugin.resolve", Args: map[string]any{
		"project": "authmereloaded", "loader": "paper", "minecraft_version": "1.21.1",
	}}, func(string, string, string, ...map[string]any) {}); err != nil {
		t.Fatal(err)
	}
	if artifactRequests != 0 {
		t.Fatalf("metadata-only resolve downloaded artifact bytes: %d", artifactRequests)
	}
	if err := executor.executeStep(context.Background(), provider, installPlan, protocol.TaskStep{Tool: "plugin.install", Args: map[string]any{
		"project": "authmereloaded", "expected_integrity": map[string]any{"algorithm": "sha512", "value": hex.EncodeToString(hash512[:])}, "source_task_id": resolvePlan.TaskID,
	}}, func(string, string, string, ...map[string]any) {}); err != nil {
		t.Fatal(err)
	}
	if artifactRequests != 1 || provider.uploadName != "AuthMe-5.7.0.jar" || string(provider.uploaded) != string(contents) {
		t.Fatalf("metadata-only install did not fetch and upload the verified artifact exactly once: requests=%d provider=%#v", artifactRequests, provider)
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
	}}, func(string, string, string, ...map[string]any) {})
	if err == nil || err.Error() != "recorded" {
		t.Fatalf("expected recording resolver sentinel, got %v", err)
	}
	if resolver.loader != "paper" || resolver.version != "1.21.1" {
		t.Fatalf("detected target = %s %s, want paper 1.21.1", resolver.loader, resolver.version)
	}
}

func TestPluginResolveReportsAuditableCompatibleArtifactAbsence(t *testing.T) {
	executor := New(t.TempDir(), nil)
	executor.pluginResolver = failingPluginResolver{err: fmt.Errorf("%w: no paper release", errNoCompatiblePluginVersion)}
	provider := &pluginProvider{}
	var events []string
	err := executor.resolvePlugin(context.Background(), provider, protocol.TaskPlan{
		TaskID: "task-plugin-absence", InstanceRef: "mcs:daemon:instance",
	}, protocol.TaskStep{ID: "s1", Tool: "plugin.resolve", Args: map[string]any{
		"project": "sodium-extra", "loader": "paper", "minecraft_version": "1.21.1",
	}}, func(_, kind, summary string, _ ...map[string]any) {
		if kind == "plugin" {
			events = append(events, summary)
		}
	})
	if err != nil {
		t.Fatalf("resolvePlugin() error = %v", err)
	}
	if len(events) != 1 || !strings.Contains(events[0], "resolution=no-compatible-artifact") || !strings.Contains(events[0], "requested_minecraft_version=1.21.1") {
		t.Fatalf("unexpected events: %#v", events)
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

func TestLoadedPluginInventoryParsesPaperColorizedMultilineCallback(t *testing.T) {
	fixture := "\x1b[32m[Server thread/INFO]: \u00a7aServer Plugins (3):\u00a7r\n[Server thread/INFO]: \u00a77Bukkit Plugins:\u00a7r\n[Server thread/INFO]: \u00a77 - Chunky, LuckPerms\u00a7r\n[Server thread/INFO]: \u00a77 - ViaVersion\u00a7r"
	declared, names, ok := loadedPluginInventory(fixture)
	if !ok || declared != 3 || strings.Join(names, ",") != "Chunky,LuckPerms,ViaVersion" {
		t.Fatalf("unexpected parsed inventory: declared=%d names=%v ok=%v", declared, names, ok)
	}
}

func TestLoadedPluginInventoryParsesTimestampedPaperCallback(t *testing.T) {
	fixture := "[22:52:18] [Server thread/INFO]: Server Plugins (3):\n[22:52:18] [Server thread/INFO]: Bukkit Plugins:\n[22:52:18] [Server thread/INFO]:  - LuckPerms, ProtocolLib, WorldEdit"
	declared, names, ok := loadedPluginInventory(fixture)
	if !ok || declared != 3 || strings.Join(names, ",") != "LuckPerms,ProtocolLib,WorldEdit" {
		t.Fatalf("unexpected parsed inventory: declared=%d names=%v ok=%v", declared, names, ok)
	}
}

func TestLoadedPluginInventoryFailsClosedOnTruncatedOrConflictingCount(t *testing.T) {
	for _, fixture := range []string{
		"Server Plugins (3): Chunky, LuckPerms",
		"Server Plugins (1): Chunky, LuckPerms",
		"Server Plugins (2): Chunky\n[Server thread/INFO]: unrelated",
	} {
		if _, _, ok := loadedPluginInventory(fixture); ok {
			t.Fatalf("incomplete or conflicting inventory must fail closed: %q", fixture)
		}
	}
	declared, names, ok := loadedPluginInventory("Server Plugins (0):")
	if !ok || declared != 0 || len(names) != 0 {
		t.Fatalf("empty inventory is a valid fact: declared=%d names=%v ok=%v", declared, names, ok)
	}
}
