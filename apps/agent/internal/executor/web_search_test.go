package executor

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

type stubWebSearcher struct {
	response webSearchResponse
	err      error
	calls    int
}

type searchRoundTripFunc func(*http.Request) (*http.Response, error)

func (f searchRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
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

func TestGitHubOrganizationSiteSearchFindsProjectDownloadLink(t *testing.T) {
	client := &http.Client{Transport: searchRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		var body, contentType string
		switch request.URL.String() {
		case "https://api.github.com/orgs/papermc":
			body, contentType = `{"login":"PaperMC","blog":"https://papermc.io/"}`, "application/json"
		case "https://papermc.io/":
			body, contentType = `<a href="/downloads">Downloads</a><a href="https://unrelated.example/downloads">Other</a>`, "text/html"
		default:
			t.Fatalf("unexpected request: %s", request.URL)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})}
	searcher := &githubOrgSiteWebSearcher{httpClient: client, orgEndpoint: "https://api.github.com/orgs/"}
	result, err := searcher.Search(context.Background(), "PaperMC official download page paper server")
	if err != nil || result.Provider != "github-org-site" || len(result.Results) != 1 || result.Results[0].Link != "https://papermc.io/downloads" {
		t.Fatalf("expected the linked official download page, got %+v, %v", result, err)
	}
}

func TestGitHubOrganizationSiteSearchRejectsPrivateWebsite(t *testing.T) {
	client := &http.Client{Transport: searchRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"login":"PaperMC","blog":"http://127.0.0.1/"}`)), Request: request}, nil
	})}
	searcher := &githubOrgSiteWebSearcher{httpClient: client, orgEndpoint: "https://api.github.com/orgs/"}
	if _, err := searcher.Search(context.Background(), "PaperMC download"); err == nil {
		t.Fatal("private and non-HTTPS project site must be rejected")
	}
}

func TestProjectSiteLinksUnderstandsChineseDownloadQuery(t *testing.T) {
	home := mustWebSearchURL(t, "https://papermc.io/")
	results := projectSiteLinks(home, `<a href="/downloads">Downloads</a>`, "搜索 PaperMC 官方下载页", "PaperMC")
	if len(results) != 1 || results[0].Link != "https://papermc.io/downloads" {
		t.Fatalf("expected download link for Chinese query, got %+v", results)
	}
}

func mustWebSearchURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
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

func TestFallbackSearchUsesProjectSiteAfterDuckDuckGoRateLimit(t *testing.T) {
	primary := &stubWebSearcher{err: errWebSearchRateLimited}
	secondary := &stubWebSearcher{response: webSearchResponse{Provider: "github-org-site", Results: []webSearchResult{{Title: "PaperMC — Downloads", Link: "https://papermc.io/downloads", Snippet: "Linked from the project website"}}}}
	tertiary := &stubWebSearcher{err: errors.New("should not be called")}
	searcher := &fallbackWebSearcher{primary: primary, secondary: secondary, tertiary: tertiary}
	for range 2 {
		result, err := searcher.Search(context.Background(), "PaperMC official downloads")
		if err != nil || result.Provider != "github-org-site" || len(result.Results) != 1 {
			t.Fatalf("expected cached project site result, got %+v, %v", result, err)
		}
	}
	if primary.calls != 1 || secondary.calls != 1 || tertiary.calls != 0 || searcher.primaryBlockedUntil.IsZero() {
		t.Fatalf("unexpected rate limit fallback state: %d, %d, %d", primary.calls, secondary.calls, tertiary.calls)
	}
}

func TestFallbackSearchDoesNotTreatUnrelatedBingResultsAsSuccess(t *testing.T) {
	primary := &stubWebSearcher{err: errWebSearchRateLimited}
	secondary := &stubWebSearcher{err: errors.New("no matching organization")}
	tertiary := &stubWebSearcher{response: webSearchResponse{Provider: "bing-rss", Results: []webSearchResult{{Title: "Antarctic ice", Link: "https://example.org/ice", Snippet: "Travel and oceans"}}}}
	searcher := &fallbackWebSearcher{primary: primary, secondary: secondary, tertiary: tertiary}
	_, err := searcher.Search(context.Background(), "EssentialsX Minecraft")
	if err == nil || !strings.Contains(err.Error(), "no relevant results") {
		t.Fatalf("unrelated fallback results must fail explicitly: %v", err)
	}
	if primary.calls != 1 || secondary.calls != 1 || tertiary.calls != 1 {
		t.Fatalf("expected one call to each provider, got %d, %d and %d", primary.calls, secondary.calls, tertiary.calls)
	}
}
