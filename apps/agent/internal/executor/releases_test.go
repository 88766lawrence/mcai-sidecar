package executor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResolvePaperSelectsStableOfficialBuild(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/paper/1.21.1" {
			t.Fatalf("unexpected Paper path %q", request.URL.Path)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`[
  {"id":134,"channel":"BETA","downloads":{"server:default":{"name":"paper-beta.jar","url":"https://fill-data.papermc.io/v1/objects/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/paper-beta.jar","size":4194304,"checksums":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}},
  {"id":133,"channel":"STABLE","downloads":{"server:default":{"name":"paper-1.21.1-133.jar","url":"https://fill-data.papermc.io/v1/objects/39bd8c00b9e18de91dcabd3cc3dcfa5328685a53b7187a2f63280c22e2d287b9/paper-1.21.1-133.jar","size":49394394,"checksums":{"sha256":"39bd8c00b9e18de91dcabd3cc3dcfa5328685a53b7187a2f63280c22e2d287b9"}}}}
]`))
	}))
	defer server.Close()

	resolver := &officialReleaseResolver{
		httpClient:       server.Client(),
		paperBuildsURL:   server.URL + "/paper/%s",
		fabricLoadersURL: server.URL + "/fabric/%s",
	}
	artifact, err := resolver.Resolve(context.Background(), "paper", "1.21.1")
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Platform != "paper" || artifact.Name != "paper-1.21.1-133.jar" || artifact.Size != 49394394 {
		t.Fatalf("unexpected Paper artifact: %#v", artifact)
	}
}

func TestResolveFabricSelectsStableLoader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/fabric/1.20.4" {
			t.Fatalf("unexpected Fabric path %q", request.URL.Path)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`[
  {"loader":{"version":"0.15.11","stable":false},"installer":{"version":"1.0.1","stable":true}},
  {"loader":{"version":"0.15.10","stable":true},"installer":{"version":"1.0.1","stable":true}}
]`))
	}))
	defer server.Close()

	resolver := &officialReleaseResolver{
		httpClient:       server.Client(),
		paperBuildsURL:   server.URL + "/paper/%s",
		fabricLoadersURL: server.URL + "/fabric/%s",
	}
	artifact, err := resolver.Resolve(context.Background(), "fabric", "1.20.4")
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Platform != "fabric" || !strings.Contains(artifact.URL, "/1.20.4/0.15.10/1.0.1/server/jar") {
		t.Fatalf("unexpected Fabric artifact: %#v", artifact)
	}
}

func TestResolveRejectsUnsupportedPlatformAndUnsafeVersion(t *testing.T) {
	resolver := newOfficialReleaseResolver()
	if _, err := resolver.Resolve(context.Background(), "forge", "1.21.1"); err == nil {
		t.Fatal("expected unsupported platform to be rejected")
	}
	if _, err := resolver.Resolve(context.Background(), "paper", "1.21.1/../../secret"); err == nil {
		t.Fatal("expected unsafe version to be rejected")
	}
}
