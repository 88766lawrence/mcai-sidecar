package connector

import (
	"testing"

	"github.com/mcai/sidecar-agent/internal/logquery"
	"github.com/mcai/sidecar-agent/internal/protocol"
)

func TestLogsQuerySchemaRejectsSemanticTamperingBeforeExecution(t *testing.T) {
	query := logquery.New([]logquery.Group{{
		AllOf: []string{"client_connection"},
		AnyOf: []string{"connection_failure", "timeout"},
	}})
	step := protocol.TaskStep{ID: "s-log", Tool: "logs.query", Args: map[string]any{
		"window_minutes": float64(30), "max_lines": float64(300),
		"filters": []any{"connection_failure", "timeout"}, "filter_query": query,
	}}
	if err := validateBasicStepSchema(step); err != nil {
		t.Fatalf("valid structured query was rejected: %v", err)
	}

	mutations := []func(map[string]any){
		func(args map[string]any) { args["filters"] = []any{"timeout"} },
		func(args map[string]any) {
			value := args["filter_query"].(logquery.Query)
			value.Groups = []logquery.Group{{AllOf: []string{"http_request"}, AnyOf: []string{"connection_failure", "timeout"}}}
			args["filter_query"] = value
		},
		func(args map[string]any) {
			value := args["filter_query"].(logquery.Query)
			value.Groups = []logquery.Group{{AllOf: []string{"client_connection"}, AnyOf: []string{"timeout", "connection_failure"}}}
			args["filter_query"] = value
		},
	}
	for index, mutate := range mutations {
		fresh := logquery.New([]logquery.Group{{AllOf: []string{"client_connection"}, AnyOf: []string{"connection_failure", "timeout"}}})
		args := map[string]any{
			"window_minutes": float64(30), "max_lines": float64(300),
			"filters": []any{"connection_failure", "timeout"}, "filter_query": fresh,
		}
		mutate(args)
		step.Args = args
		if err := validateBasicStepSchema(step); err == nil {
			t.Fatalf("tampering case %d passed validation", index)
		}
	}
}
