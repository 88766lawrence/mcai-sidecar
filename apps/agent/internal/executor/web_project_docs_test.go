package executor

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestProjectDocsDiscoverActualOwnedFilesAndIgnoreForks(t *testing.T) {
	fallback := &stubWebSearcher{}
	s := &projectDocsWebSearcher{fallback: fallback, api: "https://api.github.com", client: &http.Client{Transport: searchRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		body := `{}`
		status := 200
		switch r.URL.Path {
		case "/orgs/widgettool/repos":
			body = `[{"name":"widgetTool","full_name":"widgetTool/widgetTool","default_branch":"main","owner":{"login":"widgetTool"}},{"name":"wiki","full_name":"widgetTool/wiki","default_branch":"main","owner":{"login":"widgetTool"}},{"name":"docs","full_name":"evil/docs","default_branch":"main","owner":{"login":"evil"}}]`
		case "/repos/widgetTool/widgetTool/readme":
			body = `{"download_url":"https://raw.githubusercontent.com/widgetTool/widgetTool/main/README.md"}`
		case "/repos/widgetTool/wiki/git/trees/main":
			body = `{"tree":[{"type":"blob","path":"pages/Installation.md"},{"type":"blob","path":"unrelated.md"},{"type":"blob","path":"private.txt"}]}`
		case "/widgetTool/widgetTool/wiki":
			body = `<a href="/widgetTool/widgetTool/wiki/Installation">Installation</a><a href="https://evil.example/Installation">other</a>`
		default:
			t.Errorf("unexpected request: %s", r.URL)
			status = 404
		}
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}}
	r, err := s.Search(context.Background(), "widgetTool installation docs")
	if err != nil || fallback.calls != 0 || len(r.Results) != 3 || !strings.Contains(r.Results[0].Link, "Installation") {
		t.Fatalf("wrong documents: %+v %v", r, err)
	}
	for _, x := range r.Results {
		if strings.Contains(x.Link, "evil") {
			t.Fatal("unowned source accepted")
		}
	}
}

func TestProjectDocsRespectExplicitSiteAndMissingExactProject(t *testing.T) {
	fallback := &stubWebSearcher{response: webSearchResponse{Provider: "fallback"}}
	calls := 0
	s := &projectDocsWebSearcher{fallback: fallback, api: "https://api.github.com", client: &http.Client{Transport: searchRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`[{"name":"wiki","full_name":"widgetTool/wiki","default_branch":"main","owner":{"login":"widgetTool"}}]`)), Request: r}, nil
	})}}
	s.Search(context.Background(), "widgetTool installation site:docs.example.org")
	if calls != 0 || fallback.calls != 1 {
		t.Fatal("site constraint was bypassed")
	}
	s.Search(context.Background(), "widgetTool installation")
	if calls != 1 || fallback.calls != 2 {
		t.Fatal("unverified organization adopted")
	}
}

func TestSourceReaderGroupsWrappedMarkdownAndPrefersWikiBody(t *testing.T) {
	b := sourceTextBlocks("## Installation\n\nInstall the plugin only after checking\nthe required platform and server version.\n\n```sh\nplugin dangerous fragment\n```\n\n* Restart the server fully to load the plugin safely.\n")
	if len(b) != 2 || !strings.Contains(b[0], "checking the required") {
		t.Fatalf("wrapped paragraph lost: %v", b)
	}
	got := sourceHTMLBlocks(`<main><p>Installation irrelevant sidebar navigation text</p><div id="wiki-body"><p>Install the plugin only on a supported server platform.</p></div></main>`)
	if len(got) != 1 || strings.Contains(got[0], "sidebar") {
		t.Fatalf("wiki sidebar evidence: %v", got)
	}
	if ownedRawDocument("https://raw.githubusercontent.com/evil/docs/main/Installation.md", "widgetTool") {
		t.Fatal("foreign raw document accepted")
	}
}

func TestSourceReaderKeepsVersionTableHeaders(t *testing.T) {
	got := sourcePassages("supported versions", sourceHTMLBlocks(`<main><table><thead><tr><th>Server version</th><th>Clients can connect with</th></tr></thead><tbody><tr><td>1.21.x</td><td>1.21.x</td></tr></tbody></table></main>`))
	if len(got) != 1 || !strings.Contains(got[0], "Server version: 1.21.x; Clients can connect with: 1.21.x") {
		t.Fatalf("table context lost: %v", got)
	}
}

func TestSourceReaderRetainsSectionContextAndMarkdownLocationTable(t *testing.T) {
	got := sourcePassages("configuration location", sourceTextBlocks("# Configuration\n\n| Platform | Location |\n|---|---|\n| Bukkit | /plugins/Example/config.yml |\n"))
	if len(got) != 1 || !strings.Contains(got[0], "Platform: Bukkit; Location: /plugins/Example/config.yml") {
		t.Fatalf("location table lost: %v", got)
	}
	got = sourcePassages("packet limiter", sourceHTMLBlocks(`<main><h2>Packet limiter</h2><h3>max-pps</h3><p>Use this option to limit the packets per second allowed for each player.</p></main>`))
	if len(got) != 1 || !strings.Contains(got[0], "Packet limiter / max-pps") {
		t.Fatalf("section context lost: %v", got)
	}
	if sourceScore("Paper supported versions", "/adventure/platform/viaversion/") != 0 {
		t.Fatal("product name falsely matched version topic")
	}
}
