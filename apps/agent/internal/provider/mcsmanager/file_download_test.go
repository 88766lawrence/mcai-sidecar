package mcsmanager

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateBinaryFileStagesVerifiesAndCommitsWithoutOverwrite(t *testing.T) {
	want := []byte{0x50, 0x4b, 0x03, 0x04, 0xca, 0xfe}
	stagingName, moveSource, moveTarget := "", "", ""
	daemon := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/upload/create-passport":
			if request.URL.Query().Get("overwrite") != "false" {
				t.Fatalf("overwrite=%q", request.URL.Query().Get("overwrite"))
			}
			if err := request.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			file, header, err := request.FormFile("file")
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			stagingName = header.Filename
			got, _ := io.ReadAll(file)
			if string(got) != string(want) || !strings.HasPrefix(stagingName, ".mcai-download-") || !strings.HasSuffix(stagingName, ".part") {
				t.Fatalf("unexpected staging upload %q", stagingName)
			}
			_, _ = writer.Write([]byte("OK"))
		case request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/download/read-passport/"):
			if strings.TrimPrefix(request.URL.Path, "/download/read-passport/") != stagingName {
				t.Fatalf("wrong staging read %s", request.URL.Path)
			}
			_, _ = writer.Write(want)
		default:
			t.Fatalf("unexpected daemon request %s %s", request.Method, request.URL.String())
		}
	}))
	defer daemon.Close()
	panel := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/api/files/list" && request.URL.Query().Get("target") == "/":
			_, _ = writer.Write([]byte(`{"status":200,"data":{"items":[],"total":0}}`))
		case request.Method == http.MethodPost && request.URL.Path == "/api/files/mkdir":
			_, _ = writer.Write([]byte(`{"status":200,"data":true}`))
		case request.Method == http.MethodGet && request.URL.Path == "/api/files/list" && request.URL.Query().Get("target") == "downloads":
			_, _ = writer.Write([]byte(`{"status":200,"data":{"items":[],"total":0}}`))
		case request.Method == http.MethodGet && request.URL.Path == "/api/files/upload":
			if request.URL.Query().Get("upload_dir") != "downloads" {
				t.Fatalf("upload_dir=%q", request.URL.Query().Get("upload_dir"))
			}
			_, _ = writer.Write([]byte(`{"status":200,"data":{"password":"create-passport","addr":"` + strings.TrimPrefix(daemon.URL, "http://") + `"}}`))
		case request.Method == http.MethodPost && request.URL.Path == "/api/files/download":
			_, _ = writer.Write([]byte(`{"status":200,"data":{"password":"read-passport","addr":"` + strings.TrimPrefix(daemon.URL, "http://") + `"}}`))
		case request.Method == http.MethodPut && request.URL.Path == "/api/files/move":
			var body struct {
				Targets [][]string `json:"targets"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			moveSource, moveTarget = body.Targets[0][0], body.Targets[0][1]
			_, _ = writer.Write([]byte(`{"status":200,"data":true}`))
		default:
			t.Fatalf("unexpected panel request %s %s", request.Method, request.URL.String())
		}
	}))
	defer panel.Close()
	client, err := New(panel.URL, "test-key", []string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CreateBinaryFile(context.Background(), "mcs:daemon:instance", "downloads/grim.jar", want); err != nil {
		t.Fatal(err)
	}
	if moveSource != "/downloads/"+stagingName || moveTarget != "/downloads/grim.jar" {
		t.Fatalf("move %q -> %q", moveSource, moveTarget)
	}
}

func TestCreateBinaryFileRejectsExistingTargetBeforeUpload(t *testing.T) {
	requests := 0
	panel := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		writer.Header().Set("content-type", "application/json")
		if request.URL.Path != "/api/files/list" {
			t.Fatalf("unexpected request %s", request.URL.String())
		}
		if request.URL.Query().Get("target") == "/" {
			_, _ = writer.Write([]byte(`{"status":200,"data":{"items":[{"name":"downloads"}],"total":1}}`))
			return
		}
		_, _ = writer.Write([]byte(`{"status":200,"data":{"items":[{"name":"grim.jar"}],"total":1}}`))
	}))
	defer panel.Close()
	client, _ := New(panel.URL, "test-key", []string{"daemon"})
	err := client.CreateBinaryFile(context.Background(), "mcs:daemon:instance", "downloads/grim.jar", []byte("new"))
	if err == nil || !strings.Contains(err.Error(), "already exists") || requests != 2 {
		t.Fatalf("err=%v requests=%d", err, requests)
	}
}
