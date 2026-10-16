package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

func TestHangarHistoryFindsVerifiedArtifactOnSecondPage(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/versions") {
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		calls++
		if r.URL.Query().Get("offset") == "0" {
			rows := make([]map[string]any, 25)
			for i := range rows {
				rows[i] = map[string]any{"id": i + 1, "name": "new", "visibility": "public", "channel": map[string]string{"name": "Release"}, "platformDependencies": map[string][]string{"PAPER": {"1.21.11"}}}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"result": rows})
			return
		}
		if r.URL.Query().Get("offset") != "25" {
			t.Errorf("unexpected offset %s", r.URL.Query().Get("offset"))
		}
		_, _ = fmt.Fprintf(w, `{"result":[{"id":30,"name":"older","visibility":"public","channel":{"name":"Release"},"downloads":{"PAPER":{"fileInfo":{"name":"Historical.jar","sizeBytes":100,"sha256Hash":"%s"},"downloadUrl":"https://hangarcdn.papermc.io/historical.jar"}},"platformDependencies":{"PAPER":["1.21.1"]}}]}`, strings.Repeat("a", 64))
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), hangarBase: server.URL}
	artifact, err := resolver.resolveHangar(context.Background(), "luckperms", "paper", "1.21.1", true)
	if err != nil || artifact.VersionNumber != "older" || calls != 2 {
		t.Fatalf("historical resolution: artifact=%+v calls=%d err=%v", artifact, calls, err)
	}
}

func TestHangarHistoryLimitDoesNotClaimAbsence(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		rows := make([]map[string]any, 25)
		for i := range rows {
			rows[i] = map[string]any{"id": i + 1, "name": "new", "visibility": "public", "channel": map[string]string{"name": "Release"}, "platformDependencies": map[string][]string{"PAPER": {"1.21.11"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": rows})
	}))
	defer server.Close()
	resolver := &officialPluginResolver{httpClient: server.Client(), hangarBase: server.URL}
	_, err := resolver.resolveHangar(context.Background(), "luckperms", "paper", "1.21.1", true)
	if !errors.Is(err, errPluginSearchIncomplete) || errors.Is(err, errNoCompatiblePluginVersion) || calls != 4 {
		t.Fatalf("limit must be incomplete: calls=%d err=%v", calls, err)
	}
}

func TestPluginResolutionEmitsTypedNegativeAndIncompleteFacts(t *testing.T) {
	for _, test := range []struct {
		err        error
		resolution string
		fails      bool
	}{
		{errNoCompatiblePluginVersion, "no-compatible-artifact", false},
		{errPluginSearchIncomplete, "search-incomplete", false},
		{errors.New("HTTP 503"), "query-failed", true},
	} {
		t.Run(test.resolution, func(t *testing.T) {
			executor := New(t.TempDir(), nil)
			executor.pluginResolver = failingPluginResolver{err: test.err}
			var fact map[string]any
			err := executor.resolvePlugin(context.Background(), &pluginProvider{}, protocol.TaskPlan{TaskID: "resolution", InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{Args: map[string]any{"project": "arbitrary", "loader": "paper", "minecraft_version": "1.21.1"}}, func(_, kind, _ string, observed ...map[string]any) {
				if kind == "plugin" && len(observed) > 0 {
					fact = observed[0]
				}
			})
			if (err != nil) != test.fails || fact["resolution"] != test.resolution || fact["schema_version"] != "resolved-plugin/v1" || fact["artifact"] != nil {
				t.Fatalf("invalid outcome: err=%v fact=%+v", err, fact)
			}
		})
	}
}

func TestPluginResolutionAbsenceRecordsEveryCheckedSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v2/") {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write([]byte(`{"result":[]}`))
	}))
	defer server.Close()
	executor := New(t.TempDir(), nil)
	executor.pluginResolver = &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL + "/v2", hangarBase: server.URL + "/api/v1"}
	var fact map[string]any
	err := executor.resolvePlugin(context.Background(), &pluginProvider{}, protocol.TaskPlan{TaskID: "resolution", InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{Args: map[string]any{"project": "luckperms", "loader": "paper", "minecraft_version": "1.21.1"}}, func(_, kind, _ string, observed ...map[string]any) {
		if kind == "plugin" && len(observed) > 0 {
			fact = observed[0]
		}
	})
	sources, _ := fact["checked_sources"].([]string)
	if err != nil || strings.Join(sources, ",") != "Modrinth,Hangar" {
		t.Fatalf("wrong checked sources: %v %v", fact, err)
	}
}

func TestMetadataDependencyLookupDoesNotDownloadOrAuthorizeInstall(t *testing.T) {
	downloads := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/version") {
			fmt.Fprintf(w, `[{"id":"release","version_number":"7.0","dependencies":[{"project_id":"required-project","dependency_type":"required"}],"files":[{"url":%q,"filename":"Example.jar","primary":true,"hashes":{"sha512":"%s"}}]}]`, server.URL+"/artifact.jar", strings.Repeat("a", 128))
		} else {
			downloads++
			w.Write([]byte("unexpected download"))
		}
	}))
	defer server.Close()
	e := New(t.TempDir(), nil)
	e.pluginResolver = &officialPluginResolver{httpClient: server.Client(), apiBase: server.URL}
	plan := protocol.TaskPlan{TaskID: "metadata-deps", InstanceRef: "mcs:daemon:instance"}
	var fact map[string]any
	if err := e.resolvePlugin(context.Background(), &pluginProvider{}, plan, protocol.TaskStep{Args: map[string]any{"project": "example", "loader": "paper", "minecraft_version": "1.21.1"}}, func(_, kind, _ string, observed ...map[string]any) {
		if kind == "plugin" && len(observed) > 0 {
			fact = observed[0]
		}
	}); err != nil {
		t.Fatal(err)
	}
	if fact["resolution"] != "resolved" || fact["source_url"] != server.URL+"/artifact.jar" || len(fact["required_dependencies"].([]string)) != 1 {
		t.Fatalf("missing lookup metadata: %+v", fact)
	}
	err := e.installPlugin(context.Background(), &pluginProvider{}, plan, protocol.TaskStep{}, func(string, string, string, ...map[string]any) {})
	if err == nil || !strings.Contains(err.Error(), "separately verified dependencies") || downloads != 0 {
		t.Fatalf("metadata lookup authorized install or download: %v downloads=%d", err, downloads)
	}
}
