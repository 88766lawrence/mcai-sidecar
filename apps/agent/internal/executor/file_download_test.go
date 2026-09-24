package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

type staticDownloadFetcher struct {
	contents []byte
	err      error
	calls    int
}

func (f *staticDownloadFetcher) Fetch(context.Context, string) ([]byte, error) {
	f.calls++
	return append([]byte(nil), f.contents...), f.err
}

type verifiedDownloadProvider struct {
	provider.Provider
	files       map[string][]byte
	createCalls int
	readCorrupt bool
}

func (p *verifiedDownloadProvider) ListFileEntries(_ context.Context, _ string, target string) (provider.FileListing, error) {
	if target != "downloads" {
		return provider.FileListing{}, errors.New("unexpected directory")
	}
	names := []string{}
	for target := range p.files {
		if strings.HasPrefix(target, "downloads/") {
			names = append(names, strings.TrimPrefix(target, "downloads/"))
		}
	}
	return provider.FileListing{Names: names, Total: len(names)}, nil
}
func (p *verifiedDownloadProvider) CreateBinaryFile(_ context.Context, _ string, target string, contents []byte) error {
	p.createCalls++
	if _, exists := p.files[target]; exists {
		return errors.New("target exists")
	}
	p.files[target] = append([]byte(nil), contents...)
	return nil
}
func (p *verifiedDownloadProvider) ReadBinaryFile(_ context.Context, _ string, target string) ([]byte, error) {
	contents, exists := p.files[target]
	if !exists {
		return nil, errors.New("missing")
	}
	result := append([]byte(nil), contents...)
	if p.readCorrupt {
		result[0] ^= 0xff
	}
	return result, nil
}

func TestFileDownloadCreatesOnlyNewStagedFileWithByteExactEvidence(t *testing.T) {
	contents := []byte("arbitrary public artifact bytes")
	fetcher := &staticDownloadFetcher{contents: contents}
	p := &verifiedDownloadProvider{files: map[string][]byte{}}
	exec := &Executor{fileDownloader: fetcher}
	type event struct {
		kind     string
		observed map[string]any
	}
	var events []event
	step := protocol.TaskStep{ID: "s1", Tool: "file.download", Risk: "low", Args: map[string]any{"url": "https://downloads.example.org/releases/grim.jar?build=42", "target": "downloads/grim.jar"}}
	err := exec.downloadFile(context.Background(), p, protocol.TaskPlan{TaskID: "download", InstanceRef: "mcs:daemon:instance"}, step, func(_ string, kind string, _ string, values ...map[string]any) {
		if len(values) == 1 {
			events = append(events, event{kind, values[0]})
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if fetcher.calls != 1 || p.createCalls != 1 || string(p.files["downloads/grim.jar"]) != string(contents) {
		t.Fatalf("unexpected effects fetch=%d create=%d", fetcher.calls, p.createCalls)
	}
	if len(events) != 2 || events[0].kind != "download" || events[1].kind != "verification.download" || !reflect.DeepEqual(events[0].observed, events[1].observed) {
		t.Fatalf("missing producer verification events: %#v", events)
	}
	wantSHA := sha256.Sum256(contents)
	if events[0].observed["sha256"] != hex.EncodeToString(wantSHA[:]) || events[0].observed["created"] != true {
		t.Fatalf("invalid typed observation: %#v", events[0].observed)
	}
}

func TestFileDownloadNeverOverwritesExistingTarget(t *testing.T) {
	fetcher := &staticDownloadFetcher{contents: []byte("new")}
	p := &verifiedDownloadProvider{files: map[string][]byte{"downloads/grim.jar": []byte("original")}}
	exec := &Executor{fileDownloader: fetcher}
	err := exec.downloadFile(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:d:i"}, protocol.TaskStep{Tool: "file.download", Args: map[string]any{"url": "https://example.org/grim.jar", "target": "downloads/grim.jar"}}, func(string, string, string, ...map[string]any) {})
	if err == nil || !strings.Contains(err.Error(), "already exists") || fetcher.calls != 0 || p.createCalls != 0 {
		t.Fatalf("overwrite boundary failed err=%v", err)
	}
}

func TestFileDownloadChecksumAndReadbackFailuresNeverSucceed(t *testing.T) {
	for _, test := range []struct {
		name    string
		sha     string
		corrupt bool
		want    string
	}{{"checksum", strings.Repeat("0", 64), false, "SHA-256"}, {"readback", "", true, "readback"}} {
		t.Run(test.name, func(t *testing.T) {
			fetcher := &staticDownloadFetcher{contents: []byte("bytes")}
			p := &verifiedDownloadProvider{files: map[string][]byte{}, readCorrupt: test.corrupt}
			exec := &Executor{fileDownloader: fetcher}
			args := map[string]any{"url": "https://example.org/file.bin", "target": "downloads/file.bin"}
			if test.sha != "" {
				args["sha256"] = test.sha
			}
			events := 0
			err := exec.downloadFile(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:d:i"}, protocol.TaskStep{Tool: "file.download", Args: args}, func(string, string, string, ...map[string]any) { events++ })
			if err == nil || !strings.Contains(err.Error(), test.want) || events != 0 {
				t.Fatalf("fail-closed boundary err=%v events=%d", err, events)
			}
		})
	}
}

func TestFileDownloadRejectsPrivateSourcesAndActiveTargets(t *testing.T) {
	for _, args := range []map[string]any{{"url": "ftp://example.org/a.jar", "target": "downloads/a.jar"}, {"url": "http://127.0.0.1/a.jar", "target": "downloads/a.jar"}, {"url": "https://user:secret@example.org/a.jar", "target": "downloads/a.jar"}, {"url": "https://example.org/a.jar#x", "target": "downloads/a.jar"}, {"url": "https://example.org/a.jar", "target": "plugins/a.jar"}, {"url": "https://example.org/a.jar", "target": "downloads/nested/a.jar"}} {
		if _, _, _, err := validatedFileDownloadArgs(args); err == nil {
			t.Fatalf("unsafe args accepted: %#v", args)
		}
	}
}

func TestPublicInternetAndRetryBoundaries(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "::1", "fc00::1"} {
		if isPublicInternetIP(net.ParseIP(raw)) {
			t.Fatalf("non-public accepted: %s", raw)
		}
	}
	for _, raw := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if !isPublicInternetIP(net.ParseIP(raw)) {
			t.Fatalf("public rejected: %s", raw)
		}
	}
	fetcher := newSecureFileDownloadFetcher().(*secureFileDownloadFetcher)
	privateURL, _ := url.Parse("http://169.254.169.254/latest")
	if fetcher.httpClient.CheckRedirect(&http.Request{URL: privateURL}, nil) == nil {
		t.Fatal("private redirect accepted")
	}
	if autonomousRetrySafe(protocol.TaskStep{Tool: "file.download", Risk: "low"}) {
		t.Fatal("ambiguous create became replayable")
	}
}
