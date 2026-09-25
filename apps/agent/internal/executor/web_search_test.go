package executor

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type stubWebSearcher struct {
	response webSearchResponse
	err      error
	calls    int
}

func (s *stubWebSearcher) Search(_ context.Context, _ string) (webSearchResponse, error) {
	s.calls++
	return s.response, s.err
}

func TestRelevantWebSearchResultsRejectsUnrelatedProviderResponses(t *testing.T) {
	results := []webSearchResult{
		{Title: "Antarctic ice", Link: "https://example.org/antarctica", Snippet: "Travel and oceans"},
		{Title: "EssentialsX | Minecraft plugin", Link: "https://essentialsx.net/", Snippet: "Official plugin site"},
	}
	filtered := relevantWebSearchResults("EssentialsX Minecraft plugin", results)
	if len(filtered) != 1 || filtered[0].Link != "https://essentialsx.net/" {
		t.Fatalf("expected only the matching product result, got %+v", filtered)
	}
	if got := relevantWebSearchResults("EssentialsX Minecraft plugin", results[:1]); len(got) != 0 {
		t.Fatalf("unrelated RSS results must not become evidence: %+v", got)
	}
}

func TestRelevantWebSearchResultsHonorsRequestedSite(t *testing.T) {
	results := []webSearchResult{
		{Title: "Home | PaperMC", Link: "https://papermc.io/", Snippet: "Official Paper site"},
		{Title: "PaperMC mirror", Link: "https://unrelated.example/papermc", Snippet: "A mirror"},
		{Title: "Paper docs", Link: "https://docs.papermc.io/paper/", Snippet: "Official documentation"},
	}
	filtered := relevantWebSearchResults("PaperMC official site:papermc.io", results)
	if len(filtered) != 2 {
		t.Fatalf("expected official host and subdomain only, got %+v", filtered)
	}
}

func TestParseDuckDuckGoHTMLResultsDecodesSourceLinks(t *testing.T) {
	document := `<div class="web-result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpapermc.io%2Fdownloads%2F&amp;rut=abc">Downloads - PaperMC</a></h2><a class="result__snippet" href="#"><b>PaperMC</b> official downloads &amp; builds</a></div>` +
		`<div class="web-result"><a class="result__a" href="javascript:alert(1)">Unsafe</a><a class="result__snippet">Bad result</a></div>`
	results := parseDuckDuckGoHTMLResults(document)
	if len(results) != 1 || results[0].Link != "https://papermc.io/downloads/" || results[0].Snippet != "PaperMC official downloads & builds" {
		t.Fatalf("expected one direct, cleaned source result, got %+v", results)
	}
}

func TestDuckDuckGoHTMLSearcherReadsOrganicResults(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") != "EssentialsX Minecraft" || !strings.Contains(r.Header.Get("User-Agent"), "Mozilla") {
			t.Errorf("unexpected search request: %s", r.URL.String())
		}
		_, _ = w.Write([]byte(`<a class="result__a" href="https://essentialsx.net/">EssentialsX</a><a class="result__snippet">Official Minecraft plugin</a>`))
	}))
	defer server.Close()
	searcher := &duckDuckGoHTMLWebSearcher{httpClient: server.Client(), endpoint: server.URL}
	response, err := searcher.Search(context.Background(), "EssentialsX Minecraft")
	if err != nil || response.Provider != "duckduckgo-html" || len(response.Results) != 1 {
		t.Fatalf("expected one DuckDuckGo result, got %+v, %v", response, err)
	}
}

func TestBraveWebSearcherUsesHeaderAndTypedResults(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") != "PaperMC downloads" || r.Header.Get("X-Subscription-Token") != "test-key" {
			t.Errorf("unexpected Brave search request")
		}
		_, _ = w.Write([]byte(`{"web":{"results":[{"title":"Downloads - PaperMC","url":"https://papermc.io/downloads/","description":"Official PaperMC downloads","age":"2 days ago"}]}}`))
	}))
	defer server.Close()
	searcher := &braveWebSearcher{httpClient: server.Client(), endpoint: server.URL, apiKey: "test-key"}
	response, err := searcher.Search(context.Background(), "PaperMC downloads")
	if err != nil || response.Provider != "brave" || len(response.Results) != 1 || response.Results[0].Link != "https://papermc.io/downloads/" {
		t.Fatalf("expected typed Brave result, got %+v, %v", response, err)
	}
}

func TestFallbackSearchCachesRelevantDuckDuckGoResults(t *testing.T) {
	primary := &stubWebSearcher{response: webSearchResponse{Provider: "duckduckgo-html", Results: []webSearchResult{{Title: "Downloads - PaperMC", Link: "https://papermc.io/downloads/", Snippet: "Official PaperMC builds"}}}}
	secondary := &stubWebSearcher{err: errors.New("should not be called")}
	searcher := &fallbackWebSearcher{primary: primary, secondary: secondary}
	for range 2 {
		response, err := searcher.Search(context.Background(), "PaperMC official downloads")
		if err != nil || len(response.Results) != 1 {
			t.Fatalf("expected cached relevant results, got %+v, %v", response, err)
		}
	}
	if primary.calls != 1 || secondary.calls != 0 {
		t.Fatalf("unexpected provider calls: primary=%d secondary=%d", primary.calls, secondary.calls)
	}
}

func TestFallbackSearchDoesNotTreatUnrelatedBingResultsAsSuccess(t *testing.T) {
	primary := &stubWebSearcher{err: errWebSearchRateLimited}
	secondary := &stubWebSearcher{response: webSearchResponse{Provider: "bing-rss", Results: []webSearchResult{{Title: "Antarctic ice", Link: "https://example.org/ice", Snippet: "Travel and oceans"}}}}
	searcher := &fallbackWebSearcher{primary: primary, secondary: secondary}
	_, err := searcher.Search(context.Background(), "EssentialsX Minecraft")
	if err == nil || !strings.Contains(err.Error(), "no relevant results") {
		t.Fatalf("unrelated fallback results must fail explicitly: %v", err)
	}
	if primary.calls != 1 || secondary.calls != 1 {
		t.Fatalf("expected one call to each provider, got %d and %d", primary.calls, secondary.calls)
	}
}
