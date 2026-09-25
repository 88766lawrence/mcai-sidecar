package executor

import "testing"

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
