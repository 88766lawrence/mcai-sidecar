package mcsmanager

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/provider"
)

func TestDownloadFromURLUsesRootFileName(t *testing.T) {
	var received struct {
		URL      string `json:"url"`
		FileName string `json:"file_name"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/files/download_from_url" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if request.URL.Query().Get("daemonId") != "daemon" || request.URL.Query().Get("uuid") != "instance" {
			t.Fatalf("unexpected instance query: %s", request.URL.RawQuery)
		}
		if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"status":200,"data":{}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.DownloadFromURL(context.Background(), "mcs:daemon:instance", "https://example.com/paper.jar", "/server.jar"); err != nil {
		t.Fatal(err)
	}
	if received.FileName != "server.jar" {
		t.Fatalf("file_name = %q, want server.jar", received.FileName)
	}
}

func TestGetInstancePreservesRuntimeMetrics(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/instance" {
			t.Fatalf("unexpected request path %s", request.URL.Path)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"status":200,"data":{"instanceUuid":"instance","status":3,"config":{"nickname":"Metrics","startCommand":"java -Xmx2G -jar server.jar","type":"paper","docker":{"memory":0}},"info":{"version":"1.21.1"},"processInfo":{"memory":805306368,"cpu":4.25}}}`))
	}))
	defer server.Close()
	client, err := New(server.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := client.GetInstance(context.Background(), "mcs:daemon:instance")
	if err != nil {
		t.Fatal(err)
	}
	if instance.MemoryBytes != 805306368 || instance.MemoryLimitBytes != 2147483648 || instance.CPUUsage != 4.25 {
		t.Fatalf("runtime metrics not preserved: %#v", instance)
	}
}

func TestGetInstancePrefersConfiguredContainerMemoryLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"status":200,"data":{"instanceUuid":"instance","status":3,"config":{"nickname":"Metrics","startCommand":"java -Xmx2G -jar server.jar","type":"paper","docker":{"memory":3221225472}},"info":{"version":"1.21.1"},"processInfo":{"memory":805306368,"cpu":4.25}}}`))
	}))
	defer server.Close()
	client, _ := New(server.URL, "test-key", []string{"daemon"})
	instance, err := client.GetInstance(context.Background(), "mcs:daemon:instance")
	if err != nil {
		t.Fatal(err)
	}
	if instance.MemoryLimitBytes != 3221225472 {
		t.Fatalf("memory limit = %d", instance.MemoryLimitBytes)
	}
}

func TestDownloadFromURLRejectsNestedTarget(t *testing.T) {
	client, err := New("http://127.0.0.1:23333", "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.DownloadFromURL(context.Background(), "mcs:daemon:instance", "https://example.com/paper.jar", "/nested/server.jar"); err == nil {
		t.Fatal("expected nested target to be rejected")
	}
}

func TestUploadFileUsesOneTimeDaemonPassport(t *testing.T) {
	var uploadedName string
	var uploadedContents string
	daemon := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/upload/passport-1" || request.URL.Query().Get("overwrite") != "true" {
			t.Fatalf("unexpected daemon request %s %s", request.Method, request.URL.String())
		}
		if err := request.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		file, header, err := request.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		uploadedName = header.Filename
		contents, _ := io.ReadAll(file)
		uploadedContents = string(contents)
		_, _ = writer.Write([]byte("OK"))
	}))
	defer daemon.Close()

	panel := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/api/files/upload" || request.URL.Query().Get("upload_dir") != "plugins" {
			t.Fatalf("unexpected panel request %s %s", request.Method, request.URL.String())
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"status":200,"data":{"password":"passport-1","addr":"` + strings.TrimPrefix(daemon.URL, "http://") + `","remoteMappings":[]}}`))
	}))
	defer panel.Close()

	client, err := New(panel.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.UploadFile(context.Background(), "mcs:daemon:instance", "plugins", "EssentialsX.jar", []byte("jar-data")); err != nil {
		t.Fatal(err)
	}
	if uploadedName != "EssentialsX.jar" || uploadedContents != "jar-data" {
		t.Fatalf("unexpected upload %q %q", uploadedName, uploadedContents)
	}
}

func TestDeleteFilesUsesExplicitTargets(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodDelete || request.URL.Path != "/api/files/" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		body, _ := io.ReadAll(request.Body)
		if !strings.Contains(string(body), "plugins/EssentialsX.jar") {
			t.Fatalf("missing explicit delete target: %s", body)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"status":200,"data":{}}`))
	}))
	defer server.Close()
	client, err := New(server.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteFiles(context.Background(), "mcs:daemon:instance", []string{"plugins/EssentialsX.jar"}); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateStartConfigSendsOnlyStartFields(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Path != "/api/instance" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"status":200,"data":{}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	err = client.UpdateStartConfig(context.Background(), "mcs:daemon:instance", provider.StartConfig{
		StartCommand: "java -jar server.jar nogui", StopCommand: "stop", StopTimeout: 30,
	})
	if err != nil {
		t.Fatal(err)
	}
	if received["startCommand"] != "java -jar server.jar nogui" || received["stopCommand"] != "stop" || received["stopTimeout"] != float64(30) {
		t.Fatalf("unexpected config payload: %#v", received)
	}
	if len(received) != 3 {
		t.Fatalf("config update must remain scoped, got %#v", received)
	}
}

func TestStopUsesProtectedStopEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/api/protected_instance/stop" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if request.URL.Query().Get("daemonId") != "daemon" || request.URL.Query().Get("uuid") != "instance" {
			t.Fatalf("unexpected instance query: %s", request.URL.RawQuery)
		}
		if request.Header.Get("X-Requested-With") != "XMLHttpRequest" {
			t.Fatal("missing MCSManager requested-with header")
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"status":200,"data":{}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Stop(context.Background(), "mcs:daemon:instance"); err != nil {
		t.Fatal(err)
	}
}

func TestSendCommandUsesProtectedCommandEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/protected_instance/command" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if request.URL.Query().Get("daemonId") != "daemon" || request.URL.Query().Get("uuid") != "instance" || request.URL.Query().Get("command") != "say hello" {
			t.Fatalf("unexpected instance query: %s", request.URL.RawQuery)
		}
		if request.Body != nil && request.ContentLength != 0 {
			t.Fatalf("unexpected command request body with length %d", request.ContentLength)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"status":200,"data":{}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SendCommand(context.Background(), "mcs:daemon:instance", "/say hello"); err != nil {
		t.Fatal(err)
	}
}

func TestProfileRevisionIgnoresRuntimeState(t *testing.T) {
	detail := instanceDetail{InstanceUUID: "instance", Status: 0}
	detail.Config.Nickname = "Paper"
	detail.Config.StartCommand = "java -jar server.jar nogui"
	detail.Config.Type = "universal"
	detail.Info.Version = "1.21.1"

	stopped := profile("daemon", detail)
	detail.Status = 3
	running := profile("daemon", detail)

	if stopped.ProfileRevision != running.ProfileRevision {
		t.Fatalf("runtime state changed profile revision: %s != %s", stopped.ProfileRevision, running.ProfileRevision)
	}
	if stopped.State != "stopped" || running.State != "running" {
		t.Fatalf("unexpected state mapping: stopped=%s running=%s", stopped.State, running.State)
	}
}

func TestProfileRevisionIgnoresRuntimeMetricsAndCapacity(t *testing.T) {
	detail := instanceDetail{InstanceUUID: "instance", Status: 3}
	detail.Config.Nickname = "Paper"
	detail.Config.StartCommand = "java -Xmx2G -jar server.jar nogui"
	detail.Config.Type = "universal"
	detail.Info.Version = "1.21.1"
	baseline := profile("daemon", detail)
	detail.ProcessInfo.CPU = 84.5
	detail.ProcessInfo.Memory = 1610612736
	detail.Config.Docker.Memory = 3221225472
	changed := profile("daemon", detail)
	if baseline.ProfileRevision != changed.ProfileRevision {
		t.Fatalf("runtime telemetry changed profile revision: %s != %s", baseline.ProfileRevision, changed.ProfileRevision)
	}
	if changed.CPUUsage != 84.5 || changed.MemoryBytes != 1610612736 || changed.MemoryLimitBytes != 3221225472 {
		t.Fatalf("runtime telemetry was not preserved independently: %#v", changed)
	}
}

func TestEnrichProfileDiscoversPaperVersionFromRuntimeEvidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		switch request.URL.Path {
		case "/api/protected_instance/outputlog":
			_, _ = writer.Write([]byte(`{"status":200,"data":"This server is running Paper version git-Paper-123 (MC: 1.21.1)"}`))
		case "/api/files/":
			_, _ = writer.Write([]byte(`{"status":200,"data":"[Server thread/INFO]: Running Minecraft 1.21.1"}`))
		case "/api/files/list":
			_, _ = writer.Write([]byte(`{"status":200,"data":{"items":[{"name":"paper-global.yml"},{"name":"server.jar"}],"total":2}}`))
		default:
			t.Fatalf("unexpected request %s", request.URL.Path)
		}
	}))
	defer server.Close()

	client, err := New(server.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	got := client.enrichProfile(context.Background(), provider.Instance{
		Ref: "mcs:daemon:instance", Platform: "unknown", Loader: "unknown", MinecraftVersion: "",
	})
	if got.Platform != "paper" || got.Loader != "paper" || got.MinecraftVersion != "1.21.1" {
		t.Fatalf("unexpected enriched profile: %#v", got)
	}
}

func TestEnrichProfileDoesNotProbeKnownCapability(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Fatalf("known profile should not make an evidence request: %s", request.URL.Path)
	}))
	defer server.Close()
	client, err := New(server.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	got := client.enrichProfile(context.Background(), provider.Instance{
		Ref: "mcs:daemon:instance", Platform: "paper", Loader: "paper", MinecraftVersion: "1.21.1",
	})
	if got.Loader != "paper" || got.MinecraftVersion != "1.21.1" {
		t.Fatalf("known capability changed: %#v", got)
	}
}

func TestListFilesTreatsAnAbsentNestedDirectoryAsAnEmptyCollection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		switch request.URL.Query().Get("target") {
		case "/world/stats":
			writer.WriteHeader(http.StatusInternalServerError)
			_, _ = writer.Write([]byte(`{"status":500}`))
		case "/world":
			_, _ = writer.Write([]byte(`{"status":200,"data":{"items":[{"name":"region"},{"name":"data"}],"total":2}}`))
		default:
			t.Fatalf("unexpected target %q", request.URL.Query().Get("target"))
		}
	}))
	defer server.Close()
	client, err := New(server.URL, "test-key", nil)
	if err != nil {
		t.Fatal(err)
	}
	listing, err := client.ListFiles(context.Background(), "mcs:daemon:instance", "/world/stats")
	if err != nil {
		t.Fatal(err)
	}
	if listing != "共 0 项：" {
		t.Fatalf("unexpected empty listing: %q", listing)
	}
}

func TestListFilesDoesNotHideAnExistingNestedDirectoryFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		if request.URL.Query().Get("target") == "/world/stats" {
			writer.WriteHeader(http.StatusInternalServerError)
			_, _ = writer.Write([]byte(`{"status":500}`))
			return
		}
		_, _ = writer.Write([]byte(`{"status":200,"data":{"items":[{"name":"stats"}],"total":1}}`))
	}))
	defer server.Close()
	client, err := New(server.URL, "test-key", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ListFiles(context.Background(), "mcs:daemon:instance", "/world/stats"); err == nil {
		t.Fatal("expected the original provider failure for an existing directory")
	}
}
