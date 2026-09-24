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
	"strings"
	"time"
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

func newWebSearcherFromEnv() webSearcher {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv("MCAI_SEARCH_PROVIDER")))
	if provider == "" || provider == "bing-rss" {
		return &bingRSSWebSearcher{httpClient: &http.Client{Timeout: 12 * time.Second}}
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
	if len(response.Results) == 0 {
		return errors.New("web search returned no organic results")
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
