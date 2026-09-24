package executor

import (
	"context"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/logquery"
	"github.com/mcai/sidecar-agent/internal/protocol"
)

func TestLogsQueryRequiresTopicAndOneRequestedEvent(t *testing.T) {
	query := logquery.New([]logquery.Group{{
		AllOf: []string{"client_connection"},
		AnyOf: []string{"connection_failure", "timeout"},
	}})
	p := &installProvider{logBefore: strings.Join([]string{
		"[11:57:00] [spark-async-sampler-worker-thread/WARN]: [spark] Timed out waiting for world statistics",
		"[11:58:00] [Server thread/INFO]: HTTP provider request timed out",
		"[11:59:00] [Server thread/WARN]: Handshake timed out for client 10.0.0.8",
	}, "\n")}
	var evidence string
	err := NewWithReleaseResolver("", nil, nil).executeStep(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{
		Tool: "logs.query", Risk: "read", Args: map[string]any{
			"window_minutes": float64(10), "max_lines": float64(100),
			"filters": []any{"connection_failure", "timeout"}, "filter_query": query,
		},
	}, func(_, kind, summary string, _ ...map[string]any) {
		if kind == "logs" {
			evidence = summary
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(evidence, "matches=1") || !strings.Contains(evidence, "query_digest="+query.Digest) {
		t.Fatalf("structured log evidence is incomplete: %q", evidence)
	}
	if strings.Contains(evidence, "spark") || strings.Contains(evidence, "HTTP provider") {
		t.Fatalf("unrelated timeout escaped topic filtering: %q", evidence)
	}
}
