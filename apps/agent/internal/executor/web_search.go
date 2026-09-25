package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

const (
	maxWebSearchResponseBytes = 1 << 20
	maxWebSearchResults       = 10
)

type webSearchResult struct {
	Title   string `json:"title"`
	Link    string `json:"link"`
	Snippet string `json:"snippet"`
	Date    string `json:"date,omitempty"`
}

type webSearchResponse struct {
	Provider       string
	Results        []webSearchResult
	RelatedQueries []string
}

type webSearcher interface {
	Search(context.Context, string) (webSearchResponse, error)
}

type minimaxWebSearcher struct {
	apiHost    string
	apiKey     string
	httpClient *http.Client
}

type bingRSSWebSearcher struct {
	httpClient *http.Client
}

type duckDuckGoHTMLWebSearcher struct {
	httpClient *http.Client
	endpoint   string
}

type braveWebSearcher struct {
	httpClient *http.Client
	endpoint   string
	apiKey     string
}

type cachedWebSearchResponse struct {
	response webSearchResponse
	expires  time.Time
}

type fallbackWebSearcher struct {
	primary, secondary  webSearcher
	mu                  sync.Mutex
	cache               map[string]cachedWebSearchResponse
	primaryBlockedUntil time.Time
}

var (
	errWebSearchRateLimited = errors.New("web search provider rate limited")
	webSearchAnchorRE       = regexp.MustCompile(`(?is)<a\b([^>]*)>(.*?)</a>`)
	webSearchHrefRE         = regexp.MustCompile(`(?i)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')`)
	webSearchClassRE        = regexp.MustCompile(`(?i)\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')`)
)

func newWebSearcherFromEnv() webSearcher {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv("MCAI_SEARCH_PROVIDER")))
	if provider == "" || provider == "auto" {
		return &fallbackWebSearcher{
			primary: &duckDuckGoHTMLWebSearcher{
				httpClient: &http.Client{Timeout: 12 * time.Second},
				endpoint:   "https://duckduckgo.com/html/",
			},
			secondary: &bingRSSWebSearcher{httpClient: &http.Client{Timeout: 12 * time.Second}},
			cache:     make(map[string]cachedWebSearchResponse),
		}
	}
	if provider == "duckduckgo-html" {
		return &duckDuckGoHTMLWebSearcher{
			httpClient: &http.Client{Timeout: 12 * time.Second},
			endpoint:   "https://duckduckgo.com/html/",
		}
	}
	if provider == "bing-rss" {
		return &bingRSSWebSearcher{httpClient: &http.Client{Timeout: 12 * time.Second}}
	}
	if provider == "brave" {
		return &braveWebSearcher{
			httpClient: &http.Client{Timeout: 12 * time.Second},
			endpoint:   "https://api.search.brave.com/res/v1/web/search",
			apiKey:     strings.TrimSpace(os.Getenv("MCAI_SEARCH_API_KEY")),
		}
	}
	if provider != "minimax" {
		return &minimaxWebSearcher{}
	}
	host := strings.TrimSpace(os.Getenv("MCAI_SEARCH_API_HOST"))
	if host == "" {
		host = "https://api.minimax.io"
	}
	if host != "https://api.minimax.io" && host != "https://api.minimaxi.com" {
		return &minimaxWebSearcher{}
	}
	return &minimaxWebSearcher{
		apiHost: host,
		apiKey:  strings.TrimSpace(os.Getenv("MCAI_SEARCH_API_KEY")),
		httpClient: &http.Client{
			Timeout: 12 * time.Second,
		},
	}
}

func (e *Executor) executeWebSearch(ctx context.Context, step protocol.TaskStep, emit EventSink) error {
	query, err := validatedWebSearchQuery(step.Args)
	if err != nil {
		return err
	}
	if e.webSearcher == nil {
		return errors.New("web search is not configured")
	}
	response, err := e.webSearcher.Search(ctx, query)
	if err != nil {
		return err
	}
	response.Results = relevantWebSearchResults(query, response.Results)
	if len(response.Results) == 0 {
		return errors.New("web search provider returned no relevant results")
	}
	items := make([]map[string]any, 0, len(response.Results))
	lines := make([]string, 0, len(response.Results))
	for index, result := range response.Results {
		items = append(items, map[string]any{
			"title": result.Title, "url": result.Link, "snippet": result.Snippet, "date": result.Date,
		})
		lines = append(lines, fmt.Sprintf("%d. %s — %s", index+1, result.Title, result.Link))
	}
	evidence, err := json.Marshal(map[string]any{
		"schema_version":  "web-search-result/v1",
		"query":           query,
		"provider":        response.Provider,
		"results":         items,
		"related_queries": response.RelatedQueries,
	})
	if err != nil {
		return errors.New("encode web search evidence")
	}
	emit("", "web_search", fmt.Sprintf("Web search returned %d result(s):\n%s\nEvidence: %s", len(items), strings.Join(lines, "\n"), evidence))
	return nil
}

func validatedWebSearchQuery(args map[string]any) (string, error) {
	if len(args) != 1 {
		return "", errors.New("web.search accepts only the query argument")
	}
	raw, ok := args["query"].(string)
	if !ok {
		return "", errors.New("web.search requires one query string")
	}
	if strings.IndexFunc(raw, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return "", errors.New("web.search query exceeds its safe bounds")
	}
	query := strings.Join(strings.Fields(raw), " ")
	if query == "" || utf8.RuneCountInString(query) > 400 || len(strings.Fields(query)) > 50 {
		return "", errors.New("web.search query exceeds its safe bounds")
	}
	return query, nil
}

// Public RSS search can return unrelated results while still reporting HTTP 200.
// Enforce explicit site restrictions and distinctive product names before those
// results become evidence for the Agent.
func relevantWebSearchResults(query string, results []webSearchResult) []webSearchResult {
	siteHost, sitePath := "", ""
	brand := ""
	for _, field := range strings.Fields(query) {
		token := strings.Trim(field, `"'(),;`)
		if strings.HasPrefix(strings.ToLower(token), "site:") {
			candidate, err := url.Parse("https://" + token[len("site:"):])
			if err == nil {
				siteHost = strings.TrimPrefix(strings.ToLower(candidate.Hostname()), "www.")
				sitePath = strings.TrimRight(strings.ToLower(candidate.Path), "/")
			}
			continue
		}
		if brand != "" {
			continue
		}
		runes := []rune(token)
		if len(runes) < 5 {
			continue
		}
		lower, innerUpper := false, false
		for index, letter := range runes {
			lower = lower || unicode.IsLower(letter)
			innerUpper = innerUpper || (index > 0 && unicode.IsUpper(letter))
		}
		if lower && innerUpper {
			brand = strings.ToLower(token)
		}
	}
	filtered := make([]webSearchResult, 0, len(results))
	for _, result := range results {
		link, err := url.Parse(result.Link)
		if err != nil || (link.Scheme != "https" && link.Scheme != "http") || link.Hostname() == "" {
			continue
		}
		host := strings.TrimPrefix(strings.ToLower(link.Hostname()), "www.")
		if siteHost != "" && host != siteHost && !strings.HasSuffix(host, "."+siteHost) {
			continue
		}
		if sitePath != "" && !strings.HasPrefix(strings.ToLower(link.Path), sitePath) {
			continue
		}
		if brand != "" && !strings.Contains(strings.ToLower(result.Title+" "+result.Snippet+" "+result.Link), brand) {
			continue
		}
		filtered = append(filtered, result)
	}
	return filtered
}

func (s *fallbackWebSearcher) Search(ctx context.Context, query string) (webSearchResponse, error) {
	if s.primary == nil || s.secondary == nil {
		return webSearchResponse{}, errors.New("web search is not configured")
	}
	now := time.Now()
	s.mu.Lock()
	if cached, ok := s.cache[query]; ok && now.Before(cached.expires) {
		s.mu.Unlock()
		return cached.response, nil
	}
	blocked := now.Before(s.primaryBlockedUntil)
	s.mu.Unlock()

	primaryError := errors.New("duckduckgo temporarily rate limited")
	if !blocked {
		response, err := s.primary.Search(ctx, query)
		if err == nil {
			response.Results = relevantWebSearchResults(query, response.Results)
			if len(response.Results) > 0 {
				s.store(query, response)
				return response, nil
			}
			err = errors.New("duckduckgo returned no relevant results")
		}
		primaryError = err
		if errors.Is(err, errWebSearchRateLimited) {
			s.mu.Lock()
			s.primaryBlockedUntil = time.Now().Add(30 * time.Minute)
			s.mu.Unlock()
		}
	}
	response, err := s.secondary.Search(ctx, query)
	if err == nil {
		response.Results = relevantWebSearchResults(query, response.Results)
		if len(response.Results) > 0 {
			s.store(query, response)
			return response, nil
		}
		err = errors.New("bing-rss returned no relevant results")
	}
	return webSearchResponse{}, fmt.Errorf("web search failed: duckduckgo: %v; bing-rss: %w", primaryError, err)
}

func (s *fallbackWebSearcher) store(query string, response webSearchResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil || len(s.cache) >= 128 {
		s.cache = make(map[string]cachedWebSearchResponse)
	}
	s.cache[query] = cachedWebSearchResponse{response: response, expires: time.Now().Add(5 * time.Minute)}
}

func (s *duckDuckGoHTMLWebSearcher) Search(ctx context.Context, query string) (webSearchResponse, error) {
	if s.httpClient == nil || s.endpoint == "" {
		return webSearchResponse{}, errors.New("web search is not configured")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint+"?q="+url.QueryEscape(query), nil)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("create web search request: %w", err)
	}
	request.Header.Set("Accept", "text/html")
	request.Header.Set("Accept-Language", "en-US,en;q=0.9")
	request.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("web search request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusAccepted || response.StatusCode == http.StatusTooManyRequests {
		return webSearchResponse{}, fmt.Errorf("%w: HTTP %d", errWebSearchRateLimited, response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return webSearchResponse{}, fmt.Errorf("web search provider returned HTTP %d", response.StatusCode)
	}
	limited, err := io.ReadAll(io.LimitReader(response.Body, maxWebSearchResponseBytes+1))
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("read web search response: %w", err)
	}
	if len(limited) > maxWebSearchResponseBytes {
		return webSearchResponse{}, errors.New("web search response exceeds the 1 MiB limit")
	}
	results := parseDuckDuckGoHTMLResults(string(limited))
	if len(results) == 0 {
		return webSearchResponse{}, errors.New("web search returned no organic results")
	}
	return webSearchResponse{Provider: "duckduckgo-html", Results: results}, nil
}

func parseDuckDuckGoHTMLResults(document string) []webSearchResult {
	results := make([]webSearchResult, 0, maxWebSearchResults)
	for _, anchor := range webSearchAnchorRE.FindAllStringSubmatch(document, -1) {
		classes := webSearchAttribute(webSearchClassRE, anchor[1])
		switch {
		case webSearchHasClass(classes, "result__a"):
			if len(results) >= maxWebSearchResults {
				continue
			}
			link := duckDuckGoTargetURL(webSearchAttribute(webSearchHrefRE, anchor[1]))
			title := boundedWebText(html.UnescapeString(stripWebMarkup(anchor[2])), 300)
			if link != "" && title != "" {
				results = append(results, webSearchResult{Title: title, Link: link})
			}
		case webSearchHasClass(classes, "result__snippet"):
			if len(results) > 0 && results[len(results)-1].Snippet == "" {
				results[len(results)-1].Snippet = boundedWebText(html.UnescapeString(stripWebMarkup(anchor[2])), 1200)
			}
		}
	}
	filtered := results[:0]
	for _, result := range results {
		if result.Snippet != "" {
			filtered = append(filtered, result)
		}
	}
	return filtered
}

func webSearchAttribute(pattern *regexp.Regexp, attributes string) string {
	match := pattern.FindStringSubmatch(attributes)
	if len(match) != 3 {
		return ""
	}
	return html.UnescapeString(match[1] + match[2])
}

func webSearchHasClass(classes, expected string) bool {
	for _, class := range strings.Fields(classes) {
		if class == expected {
			return true
		}
	}
	return false
}

func duckDuckGoTargetURL(raw string) string {
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" {
		return ""
	}
	if strings.EqualFold(parsed.Hostname(), "duckduckgo.com") && parsed.Path == "/l/" {
		raw = parsed.Query().Get("uddg")
		parsed, err = url.Parse(raw)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" {
			return ""
		}
	}
	return parsed.String()
}

func (s *braveWebSearcher) Search(ctx context.Context, query string) (webSearchResponse, error) {
	if s.httpClient == nil || s.endpoint == "" || s.apiKey == "" {
		return webSearchResponse{}, errors.New("web search is not configured")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint+"?q="+url.QueryEscape(query)+"&count=10&result_filter=web", nil)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("create web search request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Subscription-Token", s.apiKey)
	response, err := s.httpClient.Do(request)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("web search request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		return webSearchResponse{}, fmt.Errorf("%w: HTTP %d", errWebSearchRateLimited, response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return webSearchResponse{}, fmt.Errorf("web search provider returned HTTP %d", response.StatusCode)
	}
	limited, err := io.ReadAll(io.LimitReader(response.Body, maxWebSearchResponseBytes+1))
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("read web search response: %w", err)
	}
	if len(limited) > maxWebSearchResponseBytes {
		return webSearchResponse{}, errors.New("web search response exceeds the 1 MiB limit")
	}
	var body struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
				Age         string `json:"age"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.Unmarshal(limited, &body); err != nil {
		return webSearchResponse{}, errors.New("web search provider returned invalid JSON")
	}
	result := webSearchResponse{Provider: "brave"}
	for _, item := range body.Web.Results {
		if len(result.Results) >= maxWebSearchResults {
			break
		}
		link, parseErr := url.Parse(strings.TrimSpace(item.URL))
		if parseErr != nil || (link.Scheme != "https" && link.Scheme != "http") || link.Hostname() == "" {
			continue
		}
		title := boundedWebText(html.UnescapeString(stripWebMarkup(item.Title)), 300)
		snippet := boundedWebText(html.UnescapeString(stripWebMarkup(item.Description)), 1200)
		if title == "" || snippet == "" {
			continue
		}
		result.Results = append(result.Results, webSearchResult{Title: title, Link: link.String(), Snippet: snippet, Date: boundedWebText(item.Age, 100)})
	}
	if len(result.Results) == 0 {
		return webSearchResponse{}, errors.New("web search returned no organic results")
	}
	return result, nil
}

func (s *minimaxWebSearcher) Search(ctx context.Context, query string) (webSearchResponse, error) {
	if s.apiHost == "" || s.apiKey == "" || s.httpClient == nil {
		return webSearchResponse{}, errors.New("web search is not configured")
	}
	body, err := json.Marshal(map[string]string{"q": query})
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("encode web search request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.apiHost+"/v1/coding_plan/search", bytes.NewReader(body))
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("create web search request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+s.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("MM-API-Source", "MCAI-Agent")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("web search request failed: %w", err)
	}
	defer response.Body.Close()
	limited, err := io.ReadAll(io.LimitReader(response.Body, maxWebSearchResponseBytes+1))
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("read web search response: %w", err)
	}
	if len(limited) > maxWebSearchResponseBytes {
		return webSearchResponse{}, errors.New("web search response exceeds the 1 MiB limit")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return webSearchResponse{}, fmt.Errorf("web search provider returned HTTP %d", response.StatusCode)
	}
	var raw struct {
		Organic []struct {
			Title   string `json:"title"`
			Link    string `json:"link"`
			Snippet string `json:"snippet"`
			Date    string `json:"date"`
		} `json:"organic"`
		Related []struct {
			Query string `json:"query"`
		} `json:"related_searches"`
		BaseResponse struct {
			StatusCode int    `json:"status_code"`
			StatusMsg  string `json:"status_msg"`
		} `json:"base_resp"`
	}
	if err := json.Unmarshal(limited, &raw); err != nil {
		return webSearchResponse{}, errors.New("web search provider returned invalid JSON")
	}
	if raw.BaseResponse.StatusCode != 0 {
		return webSearchResponse{}, fmt.Errorf("web search provider rejected the request with code %d", raw.BaseResponse.StatusCode)
	}
	result := webSearchResponse{Provider: "minimax-coding-plan"}
	for _, item := range raw.Organic {
		if len(result.Results) >= maxWebSearchResults {
			break
		}
		link, parseErr := url.Parse(strings.TrimSpace(item.Link))
		if parseErr != nil || (link.Scheme != "https" && link.Scheme != "http") || link.Hostname() == "" {
			continue
		}
		title := boundedWebText(item.Title, 300)
		snippet := boundedWebText(item.Snippet, 1200)
		if title == "" || snippet == "" {
			continue
		}
		result.Results = append(result.Results, webSearchResult{
			Title: title, Link: link.String(), Snippet: snippet, Date: boundedWebText(item.Date, 100),
		})
	}
	for _, item := range raw.Related {
		if len(result.RelatedQueries) >= maxWebSearchResults {
			break
		}
		if query := boundedWebText(item.Query, 400); query != "" {
			result.RelatedQueries = append(result.RelatedQueries, query)
		}
	}
	return result, nil
}

func (s *bingRSSWebSearcher) Search(ctx context.Context, query string) (webSearchResponse, error) {
	if s.httpClient == nil {
		return webSearchResponse{}, errors.New("web search is not configured")
	}
	endpoint := "https://www.bing.com/search?q=" + url.QueryEscape(query) + "&format=rss&mkt=zh-CN&cc=CN&setlang=zh-CN&safeSearch=Strict"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("create web search request: %w", err)
	}
	request.Header.Set("Accept", "application/rss+xml, application/xml;q=0.9")
	request.Header.Set("User-Agent", "MCAI-Search/1.0")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("web search request failed: %w", err)
	}
	defer response.Body.Close()
	limited, err := io.ReadAll(io.LimitReader(response.Body, maxWebSearchResponseBytes+1))
	if err != nil {
		return webSearchResponse{}, fmt.Errorf("read web search response: %w", err)
	}
	if len(limited) > maxWebSearchResponseBytes {
		return webSearchResponse{}, errors.New("web search response exceeds the 1 MiB limit")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return webSearchResponse{}, fmt.Errorf("web search provider returned HTTP %d", response.StatusCode)
	}
	var feed struct {
		Channel struct {
			Items []struct {
				Title       string `xml:"title"`
				Link        string `xml:"link"`
				Description string `xml:"description"`
				PubDate     string `xml:"pubDate"`
			} `xml:"item"`
		} `xml:"channel"`
	}
	if err := xml.Unmarshal(limited, &feed); err != nil {
		return webSearchResponse{}, errors.New("web search provider returned invalid RSS")
	}
	result := webSearchResponse{Provider: "bing-rss"}
	for _, item := range feed.Channel.Items {
		if len(result.Results) >= maxWebSearchResults {
			break
		}
		link, parseErr := url.Parse(strings.TrimSpace(item.Link))
		if parseErr != nil || (link.Scheme != "https" && link.Scheme != "http") || link.Hostname() == "" {
			continue
		}
		title := boundedWebText(html.UnescapeString(stripWebMarkup(item.Title)), 300)
		snippet := boundedWebText(html.UnescapeString(stripWebMarkup(item.Description)), 1200)
		if title == "" || snippet == "" {
			continue
		}
		result.Results = append(result.Results, webSearchResult{
			Title: title, Link: link.String(), Snippet: snippet, Date: boundedWebText(item.PubDate, 100),
		})
	}
	if len(result.Results) == 0 {
		return webSearchResponse{}, errors.New("web search returned no organic results")
	}
	return result, nil
}

func stripWebMarkup(value string) string {
	for {
		start := strings.IndexByte(value, '<')
		if start < 0 {
			return value
		}
		end := strings.IndexByte(value[start:], '>')
		if end < 0 {
			return value[:start]
		}
		value = value[:start] + " " + value[start+end+1:]
	}
}

func boundedWebText(value string, maxRunes int) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > maxRunes {
		runes = runes[:maxRunes]
	}
	return string(runes)
}
