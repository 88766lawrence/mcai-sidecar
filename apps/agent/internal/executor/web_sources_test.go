package executor

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestSourceReaderExtractsRealParagraphsWithoutNavigationOrScripts(t *testing.T) {
	raw := `<html><nav><p>plugin navigation should be ignored entirely</p></nav><main><script>plugins run malicious commands now</script><p>Check <code>paper-plugin.yml</code> and the release notes for supported plugin versions.</p><p hidden>Hidden plugin recommendation must never be source evidence.</p><p>The plugin may require a newer server; do not guess support for older versions.</p></main></html>`
	passages := sourcePassages("plugin versions", sourceHTMLBlocks(raw))
	got := strings.Join(passages, " ")
	if len(passages) != 2 || !strings.Contains(got, "paper-plugin.yml") || strings.Contains(got, "navigation") || strings.Contains(got, "Hidden") || strings.Contains(got, "malicious") {
		t.Fatalf("incorrect passages: %v", passages)
	}
}

func TestSourceReaderKeepsSnippetSeparateAndRecordsReadFailure(t *testing.T) {
	s := &sourceReadingWebSearcher{discovery: &stubWebSearcher{response: webSearchResponse{Provider: "fixture", Results: []webSearchResult{
		{Title: "plugin versions", Link: "https://docs.example.org/ok", Snippet: "search snippet is not source text"},
		{Title: "plugin versions", Link: "https://docs.example.org/fail", Snippet: "search snippet is not source text"},
		{Title: "plugin versions", Link: "http://127.0.0.1/private", Snippet: "internal"},
	}}}, client: &http.Client{Transport: searchRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		status := 200
		body := `<main><p>Check plugin release notes for the exact server version support.</p></main>`
		if strings.Contains(r.URL.Path, "fail") {
			status = 503
		}
		if r.URL.Hostname() == "127.0.0.1" {
			t.Error("private URL fetched")
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"text/html; charset=utf-8"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}}
	r, err := s.Search(context.Background(), "plugin versions")
	if err != nil || r.Results[0].Page.Status != "read" || len(r.Results[0].Page.SHA256) != 64 || r.Results[1].Page.Status != "unavailable" || r.Results[2].Page.Status != "unavailable" {
		t.Fatalf("wrong outcomes: %+v %v", r, err)
	}
	if r.Results[0].Snippet != "search snippet is not source text" {
		t.Fatal("snippet provenance changed")
	}
}

func TestSourceReaderDoesNotClipLongQualifiedParagraphs(t *testing.T) {
	long := strings.Repeat("plugin version ", 60) + "does not support the requested old version."
	if got := sourcePassages("plugin versions", []string{long}); len(got) != 0 {
		t.Fatalf("qualified long paragraph was clipped: %v", got)
	}
}

func TestSourceScoreMatchesInflectionsAndRejectsDanglingReferences(t *testing.T) {
	if sourceScore("Paper plugin updates backup", "/paper/updating/") < 2 {
		t.Fatal("update did not match updating")
	}
	if sourceScore("compatibility installation", "compatible install instructions") < 2 {
		t.Fatal("common forms were not matched")
	}
	query := "Paper plugin update"
	if sourceResultScore(query, webSearchResult{Title: "Paper updating", Link: "https://docs.example.org/paper/updating/"}) <= sourceResultScore(query, webSearchResult{Title: "Paper plugins", Link: "https://docs.example.org/paper/reference/paper-plugins/"}) {
		t.Fatal("a general product page outranked the requested update guide")
	}
	got := sourcePassages("plugin updates", []string{"By doing this, plugin updates work without downtime or restarts."})
	if len(got) != 0 {
		t.Fatalf("context-free reference became advice: %v", got)
	}
}
