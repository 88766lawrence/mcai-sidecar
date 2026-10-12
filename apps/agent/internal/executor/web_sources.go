package executor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// Search engines discover links; only fetched page passages are source evidence.
type webSourcePage struct {
	Status    string   `json:"status"`
	URL       string   `json:"url,omitempty"`
	FetchedAt string   `json:"fetched_at,omitempty"`
	SHA256    string   `json:"sha256,omitempty"`
	Passages  []string `json:"passages,omitempty"`
}

type sourceReadingWebSearcher struct {
	discovery webSearcher
	client    *http.Client
}

var sourceDeveloperQuery = regexp.MustCompile(`(?i)\b(?:dev|developer|development|coding|api)\b|开发|编程`)

var sourceWords = regexp.MustCompile(`[\p{L}\p{N}][\p{L}\p{N}.-]{2,}`)
var sourceContextReference = regexp.MustCompile(`(?i)^(?:by doing this|this (?:feature|allows|means|method)|these (?:steps|changes|features)|therefore|thus)\b`)

func sourceTerm(word string) string {
	for _, stem := range []string{"updat", "compatib", "install", "configur", "back"} {
		if strings.HasPrefix(word, stem) {
			return stem
		}
	}
	return strings.TrimSuffix(word, "s")
}

func sourceResultScore(query string, result webSearchResult) int {
	score := sourceScore(query, result.Title+" "+result.Link)
	// Operational instructions should not rank API development pages above
	// installation/update guides merely because they share a product name.
	if !sourceDeveloperQuery.MatchString(query) {
		u, _ := url.Parse(result.Link)
		if u != nil && (strings.Contains(u.Path, "/dev/") || strings.Contains(u.Path, "/development/") || strings.Contains(u.Path, "/api/") || strings.Contains(strings.ToLower(u.Path), "/wiki/creating-") || strings.Contains(strings.ToLower(u.Path), "/wiki/basic-api-")) {
			score -= 3
		}
	}
	if !strings.Contains(strings.ToLower(query), "network") && !strings.Contains(query, "网络") && strings.Contains(strings.ToLower(result.Link), "network-installation") {
		score -= 3
	}
	return score
}

func sourceScore(query, text string) int {
	text = strings.ToLower(text)
	score := 0
	seen := map[string]bool{}
	for _, word := range sourceWords.FindAllString(strings.ToLower(query), -1) {
		word = sourceTerm(word)
		if seen[word] || strings.Contains(word, ".") || word == "site" {
			continue
		}
		seen[word] = true
		if strings.Contains(text, word) {
			score++
			// Specific operational subjects carry more weight than a shared
			// product name; otherwise every page in a product's docs ties.
			switch word {
			case "updat", "compatib", "install", "configur", "back", "version":
				score++
			}
		}
	}
	// Preserve version table field context rather than generic product prose.
	if strings.Contains(strings.ToLower(query), "version") && strings.Contains(text, "version:") {
		score += 4
	}
	return score
}

func (s *sourceReadingWebSearcher) Search(ctx context.Context, query string) (webSearchResponse, error) {
	r, err := s.discovery.Search(ctx, query)
	if err != nil {
		return r, err
	}
	// Copy cached discoveries before attaching fresh retrieval metadata.
	r.Results = append([]webSearchResult(nil), relevantWebSearchResults(query, r.Results)...)
	sort.SliceStable(r.Results, func(i, j int) bool {
		return sourceResultScore(query, r.Results[i]) > sourceResultScore(query, r.Results[j])
	})
	ctx, cancel := context.WithTimeout(ctx, 7*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for i := range r.Results {
		r.Results[i].Page = &webSourcePage{Status: "not-read"}
		if i >= 3 {
			continue
		}
		wg.Add(1)
		go func(i int) { defer wg.Done(); r.Results[i].Page = s.read(ctx, query, r.Results[i].Link) }(i)
	}
	wg.Wait()
	return r, nil
}

func (s *sourceReadingWebSearcher) read(ctx context.Context, query, link string) *webSourcePage {
	failed := &webSourcePage{Status: "unavailable"}
	u, err := url.Parse(link)
	if err != nil || validatePublicDownloadURL(u) != nil {
		return failed
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return failed
	}
	req.Header.Set("Accept", "text/html, text/plain;q=0.8")
	req.Header.Set("User-Agent", "MCAI source reader/1.0")
	// Apply both SSRF protection and same-host provenance to every redirect.
	client := *s.client
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !strings.EqualFold(next.URL.Hostname(), u.Hostname()) {
			return fmt.Errorf("source redirect outside requested host")
		}
		return validatePublicDownloadURL(next.URL)
	}
	resp, err := client.Do(req)
	if err != nil {
		return failed
	}
	defer resp.Body.Close()
	media, params, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if resp.StatusCode != 200 || err != nil || (media != "text/html" && media != "text/plain") || (params["charset"] != "" && !strings.EqualFold(params["charset"], "utf-8")) {
		return failed
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxWebSearchResponseBytes+1))
	if err != nil || len(body) > maxWebSearchResponseBytes || !utf8.Valid(body) {
		return failed
	}
	blocks := sourceTextBlocks(string(body))
	if media == "text/html" {
		blocks = sourceHTMLBlocks(string(body))
	}
	passages := sourcePassages(query, blocks)
	if len(passages) == 0 {
		return failed
	}
	return &webSourcePage{Status: "read", URL: resp.Request.URL.String(), FetchedAt: time.Now().UTC().Format(time.RFC3339), SHA256: fmt.Sprintf("%x", sha256.Sum256(body)), Passages: passages}
}

func sourceHTMLBlocks(raw string) []string {
	doc, err := html.Parse(strings.NewReader(raw))
	if err != nil {
		return nil
	}
	root := doc
	var find func(*html.Node)
	find = func(n *html.Node) {
		if n.Type == html.ElementNode && (n.Data == "main" || n.Data == "article") {
			root = n
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if root != doc {
				return
			}
			find(c)
		}
	}
	find(doc)
	var content func(*html.Node)
	content = func(n *html.Node) {
		for _, a := range n.Attr {
			if a.Key == "id" && a.Val == "wiki-body" {
				root = n
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			content(c)
		}
	}
	content(doc)
	var blocks []string
	var text func(*html.Node) string
	text = func(n *html.Node) string {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "script", "style", "nav", "header", "footer", "aside", "form", "noscript", "svg":
				return ""
			}
			for _, a := range n.Attr {
				if a.Key == "hidden" || (a.Key == "aria-hidden" && a.Val == "true") {
					return ""
				}
			}
		}
		if n.Type == html.TextNode {
			return n.Data
		}
		var b strings.Builder
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			b.WriteString(text(c))
		}
		return b.String()
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			for _, a := range n.Attr {
				if a.Key == "hidden" || (a.Key == "aria-hidden" && a.Val == "true") {
					return
				}
			}
			switch n.Data {
			case "script", "style", "nav", "header", "footer", "aside", "form", "noscript", "svg":
				return
			}
			if n.Data == "table" {
				var headers []string
				var rows func(*html.Node)
				rows = func(row *html.Node) {
					if row.Type == html.ElementNode && row.Data == "tr" {
						var cells []string
						isHeader := false
						for c := row.FirstChild; c != nil; c = c.NextSibling {
							if c.Type == html.ElementNode && (c.Data == "th" || c.Data == "td") {
								cells = append(cells, strings.Join(strings.Fields(text(c)), " "))
								isHeader = isHeader || c.Data == "th"
							}
						}
						if isHeader {
							headers = cells
							return
						}
						if len(cells) == len(headers) && len(headers) > 0 {
							var fields []string
							for i, c := range cells {
								fields = append(fields, headers[i]+": "+c)
							}
							blocks = append(blocks, strings.Join(fields, "; "))
						}
						return
					}
					for c := row.FirstChild; c != nil; c = c.NextSibling {
						rows(c)
					}
				}
				rows(n)
				return
			}
			if n.Data == "p" || n.Data == "li" || n.Data == "pre" {
				blocks = append(blocks, strings.Join(strings.Fields(text(n)), " "))
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return blocks
}

func sourcePassages(query string, blocks []string) []string {
	type candidate struct {
		text         string
		score, index int
	}
	var all []candidate
	seen := map[string]bool{}
	for i, b := range blocks {
		b = strings.Join(strings.Fields(b), " ")
		// Preserve complete bounded paragraphs, rather than clipping a qualification.
		if utf8.RuneCountInString(b) < 30 || utf8.RuneCountInString(b) > 600 || seen[b] || sourceContextReference.MatchString(b) {
			continue
		}
		seen[b] = true
		score := sourceScore(query, b)
		q := strings.ToLower(query)
		if !strings.Contains(q, "network") && !strings.Contains(q, "proxy") && !strings.Contains(query, "网络") && !strings.Contains(query, "代理") && (strings.Contains(strings.ToLower(b), "proxy") || strings.Contains(strings.ToLower(b), "network of servers")) {
			score -= 3
		}
		if score == 0 {
			continue
		}
		all = append(all, candidate{b, score, i})
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].score > all[j].score })
	if len(all) > 3 {
		all = all[:3]
	}
	sort.Slice(all, func(i, j int) bool { return all[i].index < all[j].index })
	var result []string
	for _, c := range all {
		result = append(result, c.text)
	}
	return result
}

// Group wrapped plaintext/Markdown paragraphs; a line break is not a sentence
// boundary. Keep full paragraphs and list items rather than dropping short
// wrapped lines or extracting disconnected sentence fragments.
func sourceTextBlocks(raw string) []string {
	var blocks []string
	var paragraph []string
	flush := func() {
		if len(paragraph) > 0 {
			blocks = append(blocks, strings.Join(paragraph, " "))
			paragraph = nil
		}
	}
	fenced := false
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
			flush()
			fenced = !fenced
			continue
		}
		if fenced {
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") || line == "---" || line == "--------" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "![") || strings.HasPrefix(line, "[![") || strings.HasPrefix(line, "![]") {
			flush()
			continue
		}
		if strings.HasPrefix(line, "* ") || strings.HasPrefix(line, "- ") {
			flush()
		}
		paragraph = append(paragraph, line)
	}
	flush()
	return blocks
}
