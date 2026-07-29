package mcsmanager

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestDownloadFromURLRejectsNestedTarget(t *testing.T) {
	client, err := New("http://127.0.0.1:23333", "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.DownloadFromURL(context.Background(), "mcs:daemon:instance", "https://example.com/paper.jar", "/nested/server.jar"); err == nil {
		t.Fatal("expected nested target to be rejected")
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
