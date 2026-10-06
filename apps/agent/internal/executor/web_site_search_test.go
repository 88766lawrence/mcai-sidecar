package executor

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestSiteSearchUsesOfficialSitemapBeforeAnEngine(t *testing.T) {
	fallback := &stubWebSearcher{}
	s := &siteFirstWebSearcher{fallback: fallback, client: &http.Client{Transport: searchRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		body := `<urlset><url><loc>https://docs.example.org/widget/install-compatibility</loc></url><url><loc>https://evil.example.org/widget/install-compatibility</loc></url><url><loc>http://127.0.0.1/widget/install-compatibility</loc></url></urlset>`
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}}
	r, err := s.Search(context.Background(), "widget install compatibility site:docs.example.org")
	if err != nil || r.Provider != "site-sitemap" || fallback.calls != 0 || len(r.Results) != 1 || r.Results[0].Link != "https://docs.example.org/widget/install-compatibility" {
		t.Fatalf("wrong site discovery: %+v %v fallback %d", r, err, fallback.calls)
	}
}
func TestSiteSearchFallsBackWhenSitemapHasNoRelevantPages(t *testing.T) {
	fallback := &stubWebSearcher{response: webSearchResponse{Provider: "fixture"}}
	s := &siteFirstWebSearcher{fallback: fallback, client: &http.Client{Transport: searchRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`<urlset><url><loc>https://docs.example.org/unrelated</loc></url></urlset>`)), Request: r}, nil
	})}}
	r, err := s.Search(context.Background(), "widget install compatibility site:docs.example.org")
	if err != nil || r.Provider != "fixture" || fallback.calls != 1 {
		t.Fatalf("missing fallback: %+v %v", r, err)
	}
}
