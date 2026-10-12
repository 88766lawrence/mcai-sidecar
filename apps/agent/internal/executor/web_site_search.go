package executor

import (
	"context"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type siteFirstWebSearcher struct {
	fallback webSearcher
	client   *http.Client
}
type searchSitemap struct {
	URLs []struct {
		Location string `xml:"loc"`
		Date     string `xml:"lastmod"`
	} `xml:"url"`
	Maps []struct {
		Location string `xml:"loc"`
	} `xml:"sitemap"`
}

func (s *siteFirstWebSearcher) Search(ctx context.Context, query string) (webSearchResponse, error) {
	for _, word := range strings.Fields(query) {
		if !strings.HasPrefix(strings.ToLower(word), "site:") {
			continue
		}
		u, err := url.Parse("https://" + strings.Trim(word[5:], `"'(),;`))
		if err != nil || validatePublicDownloadURL(u) != nil {
			break
		}
		siteCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		results := s.siteSearch(siteCtx, query, u)
		cancel()
		if len(results) > 0 {
			return webSearchResponse{Provider: "site-sitemap", Results: results}, nil
		}
		break
	}
	return s.fallback.Search(ctx, query)
}

func (s *siteFirstWebSearcher) siteSearch(ctx context.Context, query string, site *url.URL) []webSearchResult {
	var candidates []webSearchResult
	queue := []string{"https://" + site.Host + "/sitemap.xml", "https://" + site.Host + "/sitemap-index.xml"}
	seen := map[string]bool{}
	for calls := 0; calls < 4 && len(queue) > 0; {
		link := queue[0]
		queue = queue[1:]
		if seen[link] {
			continue
		}
		seen[link] = true
		calls++
		m, err := s.sitemap(ctx, link, site.Hostname())
		if err != nil {
			continue
		}
		for _, entry := range m.URLs {
			u, err := url.Parse(entry.Location)
			if err != nil || !strings.EqualFold(u.Hostname(), site.Hostname()) || validatePublicDownloadURL(u) != nil || siteDocumentScore(query, u.Path) < 2 {
				continue
			}
			candidates = append(candidates, webSearchResult{Title: boundedWebText(u.Hostname()+" — "+u.Path, 300), Link: u.String(), Snippet: "Discovered in the requested site's sitemap; page passages are separate retrieval evidence.", Date: boundedWebText(entry.Date, 100)})
		}
		for _, entry := range m.Maps {
			u, err := url.Parse(entry.Location)
			if err == nil && strings.EqualFold(u.Hostname(), site.Hostname()) && validatePublicDownloadURL(u) == nil {
				queue = append(queue, u.String())
			}
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		left, _ := url.Parse(candidates[i].Link)
		right, _ := url.Parse(candidates[j].Link)
		return siteDocumentScore(query, left.Path) > siteDocumentScore(query, right.Path)
	})
	result := relevantWebSearchResults(query, candidates)
	unique := result[:0]
	seen = map[string]bool{}
	for _, r := range result {
		if !seen[r.Link] {
			seen[r.Link] = true
			unique = append(unique, r)
		}
		if len(unique) == maxWebSearchResults {
			break
		}
	}
	return unique
}

func (s *siteFirstWebSearcher) sitemap(ctx context.Context, link, host string) (searchSitemap, error) {
	var m searchSitemap
	u, err := url.Parse(link)
	if err != nil || validatePublicDownloadURL(u) != nil || !strings.EqualFold(u.Hostname(), host) {
		return m, errors.New("invalid sitemap URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return m, err
	}
	client := *s.client
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !strings.EqualFold(next.URL.Hostname(), host) {
			return errors.New("sitemap redirect outside requested host")
		}
		return validatePublicDownloadURL(next.URL)
	}
	r, err := client.Do(req)
	if err != nil {
		return m, err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return m, errors.New("sitemap unavailable")
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, maxWebSearchResponseBytes+1))
	if err != nil || len(b) > maxWebSearchResponseBytes {
		return m, errors.New("sitemap exceeds bounds")
	}
	err = xml.Unmarshal(b, &m)
	return m, err
}

// Runtime requirements often live in a getting-started/installation guide;
// the path itself may not contain the requested language/runtime name.
func siteDocumentScore(query, path string) int {
	score := sourceScore(query, path)
	q := strings.ToLower(query)
	p := strings.ToLower(path)
	if (strings.Contains(q, "java") || strings.Contains(q, "requirement") || strings.Contains(query, "要求")) && (strings.Contains(p, "getting-started") || strings.Contains(p, "java-install")) {
		score += 2
	}
	return score
}
