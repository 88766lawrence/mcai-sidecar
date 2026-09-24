package logquery

import (
	"strings"
	"testing"
)

func fixtureQuery() Query {
	return New([]Group{{AllOf: []string{"client_connection"}, AnyOf: []string{"connection_failure", "timeout"}}})
}

func TestTopicAndEventCombination(t *testing.T) {
	query := fixtureQuery()
	for _, line := range []string{
		"[User Authenticator] Login failed for client QuartzFox",
		"Connection refused for player BlueHarbor",
		"Handshake timed out for client 10.0.0.8",
	} {
		if !Match(line, query) {
			t.Fatalf("expected relevant match: %s", line)
		}
	}
	for _, line := range []string{
		"[spark] Timed out waiting for world statistics",
		"HTTP provider request timeout",
		"Backup operation timed out",
		"Chunk world save timeout",
	} {
		if Match(line, query) {
			t.Fatalf("unrelated timeout matched: %s", line)
		}
	}
}

func TestPureTimeoutRemainsBroad(t *testing.T) {
	query := New([]Group{{AllOf: []string{"timeout"}, AnyOf: []string{}}})
	if !Match("backup timed out", query) {
		t.Fatal("pure timeout query should match")
	}
}

func TestServerLagTopicWithAlternativeEvents(t *testing.T) {
	query := New([]Group{{AllOf: []string{"server_lag"}, AnyOf: []string{"cannot_keep_up", "tick_timeout"}}})
	for _, line := range []string{
		"Can't keep up! Is the server overloaded? Running 2400ms or 48 ticks behind",
		"A single server tick took 60.00 seconds",
	} {
		if !Match(line, query) {
			t.Fatalf("expected server lag match: %s", line)
		}
	}
	if Match("HTTP provider request timed out while fetching metadata", query) {
		t.Fatal("unrelated timeout matched server lag query")
	}
}

func TestMemoryAndWorldStorageTopicAlternatives(t *testing.T) {
	tests := []struct {
		query    Query
		positive []string
		negative string
	}{
		{New([]Group{{AllOf: []string{"memory_resource"}, AnyOf: []string{"out_of_memory", "heap_exhaustion", "gc_overhead"}}}), []string{"java.lang.OutOfMemoryError: Java heap space", "GC overhead limit exceeded"}, "World save failed for level main"},
		{New([]Group{{AllOf: []string{"world_storage"}, AnyOf: []string{"save_failure", "chunk_corruption", "chunk_read_failure"}}}), []string{"Failed to save world data", "Region corrupted while loading chunk", "Failed to read chunk 4,8"}, "HTTP provider request timeout"},
	}
	for _, test := range tests {
		for _, line := range test.positive {
			if !Match(line, test.query) {
				t.Fatalf("expected relevant match: %s", line)
			}
		}
		if Match(test.negative, test.query) {
			t.Fatalf("unrelated line matched: %s", test.negative)
		}
	}
}

func TestGenericTopicAndAlternativeEvents(t *testing.T) {
	query := New([]Group{{AllOf: []string{"software_component"}, AnyOf: []string{"initialization_failure", "dependency_missing"}}})
	for _, line := range []string{
		"[ModuleLoader] Extension Vega failed to initialize",
		"[DependencyResolver] Module Vega missing required dependency CoreAPI",
	} {
		if !Match(line, query) {
			t.Fatalf("expected component event match: %s", line)
		}
	}
	for _, line := range []string{
		"Player connection timed out during login",
		"Plugin Vega loaded successfully",
		"Backup dependency metadata refreshed",
	} {
		if Match(line, query) {
			t.Fatalf("unrelated event matched: %s", line)
		}
	}
}

func TestGenericTopicQueryTamperingIsRejected(t *testing.T) {
	for name, mutate := range map[string]func(*Query){
		"generic all":   func(query *Query) { query.Groups[0] = Group{AllOf: []string{"all"}, AnyOf: []string{}} },
		"missing topic": func(query *Query) { query.Groups[0].AllOf = []string{} },
		"logic projection": func(query *Query) {
			query.Groups[0].AllOf = append(query.Groups[0].AllOf, query.Groups[0].AnyOf...)
			query.Groups[0].AnyOf = []string{}
		},
		"digest": func(query *Query) { query.Digest = strings.Repeat("0", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			query := New([]Group{{AllOf: []string{"software_component"}, AnyOf: []string{"initialization_failure", "dependency_missing"}}})
			mutate(&query)
			if Validate(query) == nil {
				t.Fatal("tampered query was accepted")
			}
		})
	}
}

func TestFilterQueryTamperingIsRejected(t *testing.T) {
	for name, mutate := range map[string]func(*Query){
		"subject": func(query *Query) { query.Groups[0].AllOf = []string{"http_request"} },
		"logic": func(query *Query) {
			query.Groups[0].AllOf = append(query.Groups[0].AllOf, query.Groups[0].AnyOf...)
			query.Groups[0].AnyOf = nil
		},
		"group": func(query *Query) {
			query.Groups = append(query.Groups, Group{AllOf: []string{"backup"}, AnyOf: []string{"timeout"}})
		},
		"condition": func(query *Query) { query.Groups[0].AnyOf[0] = "unknown_condition" },
	} {
		t.Run(name, func(t *testing.T) {
			query := fixtureQuery()
			mutate(&query)
			if Validate(query) == nil {
				t.Fatal("tampered query was accepted")
			}
		})
	}
}
