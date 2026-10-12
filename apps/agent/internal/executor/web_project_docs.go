package executor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Exact project organizations provide repository-owned documentation even when
// unkeyed search engines challenge requests or a website requires JavaScript.
// No document contents or project-specific URLs are embedded here.
type projectDocsWebSearcher struct {
	fallback webSearcher
	client   *http.Client
	api      string
	mu       sync.Mutex
	metadata map[string]projectDocMetadata
}

type projectDocMetadata struct {
	body    []byte
	expires time.Time
}

type projectDocRepository struct {
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	DefaultBranch string `json:"default_branch"`
	Archived      bool   `json:"archived"`
	Fork          bool   `json:"fork"`
	Owner         struct {
		Login string `json:"login"`
	} `json:"owner"`
}

func (s *projectDocsWebSearcher) Search(ctx context.Context, query string) (webSearchResponse, error) {
	brand := distinctiveWebSearchBrand(query)
	// Explicit site constraints cannot be silently replaced with a GitHub source.
	if brand != "" && !strings.Contains(strings.ToLower(query), "site:") {
		docCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		results := s.projectDocs(docCtx, query, brand)
		cancel()
		if len(results) > 0 {
			return webSearchResponse{Provider: "project-repository-docs", Results: results}, nil
		}
	}
	return s.fallback.Search(ctx, query)
}

func (s *projectDocsWebSearcher) getJSON(ctx context.Context, path string, out any) error {
	if s.client == nil || s.api == "" {
		return errors.New("project docs unavailable")
	}
	s.mu.Lock()
	cached, ok := s.metadata[path]
	s.mu.Unlock()
	if ok && time.Now().Before(cached.expires) {
		return json.Unmarshal(cached.body, out)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.api+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "MCAI source discovery/1.0")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New("project metadata unavailable")
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxWebSearchResponseBytes+1))
	if err != nil || len(b) > maxWebSearchResponseBytes {
		return errors.New("project metadata exceeds bounds")
	}
	if err := json.Unmarshal(b, out); err != nil {
		return err
	}
	s.mu.Lock()
	if s.metadata == nil || len(s.metadata) >= 16 {
		s.metadata = make(map[string]projectDocMetadata)
	}
	s.metadata[path] = projectDocMetadata{body: b, expires: time.Now().Add(10 * time.Minute)}
	s.mu.Unlock()
	return nil
}

func (s *projectDocsWebSearcher) projectDocs(ctx context.Context, query, brand string) []webSearchResult {
	var repos []projectDocRepository
	if s.getJSON(ctx, "/orgs/"+url.PathEscape(brand)+"/repos?per_page=100", &repos) != nil {
		return nil
	}
	var results []webSearchResult
	var main *projectDocRepository
	var docs []projectDocRepository
	for i := range repos {
		r := repos[i]
		if r.Fork || r.Archived || !strings.EqualFold(r.Owner.Login, brand) || r.FullName != r.Owner.Login+"/"+r.Name || r.DefaultBranch == "" {
			continue
		}
		if strings.EqualFold(r.Name, brand) {
			copy := r
			main = &copy
		}
		name := strings.ToLower(r.Name)
		if name == "wiki" || name == "docs" || name == "documentation" || name == strings.ToLower(brand)+"-docs" {
			docs = append(docs, r)
		}
	}
	if main == nil {
		return nil
	} // Do not adopt a namesake organization without its exact project.
	// Readme links to user documentation and contains platform/version qualifiers.
	var readme struct {
		DownloadURL string `json:"download_url"`
	}
	if s.getJSON(ctx, "/repos/"+main.FullName+"/readme", &readme) == nil && ownedRawDocument(readme.DownloadURL, brand) {
		results = append(results, webSearchResult{Title: main.FullName + " — README", Link: readme.DownloadURL, Snippet: "README returned by the exact project repository; page passages require a separate read."})
	}
	for i, r := range docs {
		if i >= 2 {
			break
		}
		var tree struct {
			Truncated bool `json:"truncated"`
			Entries   []struct {
				Path string `json:"path"`
				Type string `json:"type"`
			} `json:"tree"`
		}
		if s.getJSON(ctx, "/repos/"+r.FullName+"/git/trees/"+url.PathEscape(r.DefaultBranch)+"?recursive=1", &tree) != nil || tree.Truncated {
			continue
		}
		for _, e := range tree.Entries {
			if e.Type != "blob" || !strings.HasSuffix(strings.ToLower(e.Path), ".md") || sourceScore(query, e.Path) < 2 {
				continue
			}
			parts := strings.Split(e.Path, "/")
			for j := range parts {
				parts[j] = url.PathEscape(parts[j])
			}
			link := "https://raw.githubusercontent.com/" + r.FullName + "/" + url.PathEscape(r.DefaultBranch) + "/" + strings.Join(parts, "/")
			if !ownedRawDocument(link, brand) {
				continue
			}
			results = append(results, webSearchResult{Title: r.FullName + " — " + e.Path, Link: link, Snippet: "Document listed in the matching project's documentation repository tree; source text requires a separate read."})
		}
	}
	// The wiki page is discovered through GitHub's actual project page links, not
	// guessed Installation/Compatibility URLs. Only same-repository wiki links count.
	wiki := "https://github.com/" + main.FullName + "/wiki"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, wiki, nil)
	req.Header.Set("User-Agent", "MCAI source discovery/1.0")
	if resp, err := s.client.Do(req); err == nil {
		b, readErr := io.ReadAll(io.LimitReader(resp.Body, maxWebSearchResponseBytes+1))
		resp.Body.Close()
		if resp.StatusCode == 200 && readErr == nil && len(b) <= maxWebSearchResponseBytes {
			base, _ := url.Parse(wiki)
			for _, a := range webSearchAnchorRE.FindAllStringSubmatch(string(b), -1) {
				u, err := url.Parse(webSearchAttribute(webSearchHrefRE, a[1]))
				if err != nil {
					continue
				}
				u = base.ResolveReference(u)
				u.Fragment = ""
				if u.Scheme != "https" || u.Host != "github.com" || !strings.HasPrefix(strings.ToLower(u.Path), strings.ToLower("/"+main.FullName+"/wiki/")) || strings.Contains(u.Path, "/_") || projectDocLinkScore(query, u.Path) < 2 {
					continue
				}
				results = append(results, webSearchResult{Title: main.FullName + " — " + stripWebMarkup(a[2]), Link: u.String(), Snippet: "Linked from the matching project's GitHub Wiki."})
			}
		}
	}
	sort.SliceStable(results, func(i, j int) bool {
		return sourceResultScore(query, results[i]) > sourceResultScore(query, results[j])
	})
	var unique []webSearchResult
	seen := map[string]bool{}
	for _, r := range relevantWebSearchResults(query, results) {
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

func ownedRawDocument(link, brand string) bool {
	u, err := url.Parse(link)
	if err != nil || validatePublicDownloadURL(u) != nil || u.Scheme != "https" || u.Host != "raw.githubusercontent.com" {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	return len(parts) >= 4 && strings.EqualFold(parts[0], brand) && strings.HasSuffix(strings.ToLower(u.Path), ".md")
}

// Installation guides commonly contain platform/version support tables.
// This only admits an actually linked guide for reading; it proves no support.
func projectDocLinkScore(query, path string) int {
	subject := path
	if i := strings.Index(strings.ToLower(subject), "/wiki/"); i >= 0 {
		subject = subject[i+6:]
	}
	score := sourceScore(query, subject)
	q := strings.ToLower(query)
	p := strings.ToLower(path)
	if (strings.Contains(q, "version") || strings.Contains(q, "support") || strings.Contains(q, "版本") || strings.Contains(q, "兼容")) && strings.Contains(p, "install") {
		score += 2
	}
	return score
}
