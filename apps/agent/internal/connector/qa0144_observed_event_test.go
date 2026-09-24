package connector

import (
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
)

func TestQA0144ConfirmedTaskEventCarriesProducerObservation(t *testing.T) {
	observed := map[string]any{"schema_version": "logs-query-result/v1", "matches": 68}
	payload := confirmedTaskEventPayload(protocol.TaskPlan{TaskID: "task-1"}, "", "logs", "display only", observed)
	got, ok := payload["observed"].(map[string]any)
	if !ok || got["schema_version"] != "logs-query-result/v1" || got["matches"] != 68 {
		t.Fatalf("producer observation was not preserved: %#v", payload)
	}
}
