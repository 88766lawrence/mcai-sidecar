package connector

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mcai/sidecar-agent/internal/executor"
	"github.com/mcai/sidecar-agent/internal/identity"
	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

type Connector struct {
	gatewayURL        string
	tenantID          string
	displayName       string
	identity          *identity.Identity
	executor          *executor.Executor
	collect           func(context.Context) ([]provider.Instance, error)
	inventoryInterval time.Duration
	writeMu           sync.Mutex
	conn              *websocket.Conn
	instanceMu        sync.Map
	rejectionMu       sync.Mutex
	rejectedTasks     map[string]bool
	sendMessage       func(string, any) error
}

func New(gatewayURL, tenantID, displayName string, id *identity.Identity, exec *executor.Executor, collect func(context.Context) ([]provider.Instance, error), inventoryInterval time.Duration) (*Connector, error) {
	u, err := url.Parse(gatewayURL)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "wss" && !(u.Scheme == "ws" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1")) {
		return nil, errors.New("gateway must use WSS (WS is allowed only for localhost)")
	}
	if inventoryInterval <= 0 {
		inventoryInterval = 5 * time.Minute
	}
	return &Connector{gatewayURL: gatewayURL, tenantID: tenantID, displayName: displayName, identity: id, executor: exec, collect: collect, inventoryInterval: inventoryInterval, rejectedTasks: map[string]bool{}}, nil
}

func (c *Connector) Run(ctx context.Context) error {
	backoff := time.Second
	for ctx.Err() == nil {
		if err := c.runSession(ctx); err != nil {
			log.Printf("gateway session ended: %v", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
	return ctx.Err()
}

func (c *Connector) runSession(ctx context.Context) error {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, c.gatewayURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	c.conn = conn
	hello := map[string]any{"public_key": c.identity.PublicKeyString(), "display_name": c.displayName, "version": "0.1.0"}
	if c.tenantID == "" {
		hello["pairing_code"] = c.identity.PairingCode
		log.Printf("pairing code: %s", c.identity.PairingCode)
	}
	if err := c.send("agent.hello", hello); err != nil {
		return err
	}
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	inventory := time.NewTicker(c.inventoryInterval)
	defer inventory.Stop()
	done := make(chan error, 1)
	go func() {
		for {
			_, raw, readErr := conn.ReadMessage()
			if readErr != nil {
				done <- readErr
				return
			}
			if handleErr := c.handle(ctx, raw); handleErr != nil {
				log.Printf("rejected gateway message: %v", handleErr)
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-done:
			return err
		case <-heartbeat.C:
			if err := c.send("heartbeat", map[string]any{"at": time.Now().UTC()}); err != nil {
				return err
			}
		case <-inventory.C:
			if err := c.reportInventory(ctx); err != nil {
				log.Printf("inventory report failed: %v", err)
			}
		}
	}
}

func (c *Connector) handle(ctx context.Context, raw []byte) error {
	var header struct {
		Type     string          `json:"type"`
		TenantID string          `json:"tenant_id"`
		Payload  json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return err
	}
	switch header.Type {
	case "agent.welcome":
		if header.TenantID != "" {
			c.tenantID = header.TenantID
		}
		return c.reportInventory(ctx)
	case "agent.paired":
		if header.TenantID == "" {
			return errors.New("paired message omitted tenant")
		}
		c.tenantID = header.TenantID
		return c.reportInventory(ctx)
	case "task.execute":
		var plan protocol.TaskPlan
		if err := json.Unmarshal(header.Payload, &plan); err != nil {
			return err
		}
		if plan.SchemaVersion != "task-plan/v1" || plan.TaskID == "" || plan.InstanceRef == "" {
			if plan.TaskID != "" {
				return c.rejectTask(ctx, plan, errors.New("invalid task plan envelope"))
			}
			return errors.New("invalid task plan")
		}
		if err := validateOperationPlan(plan); err != nil {
			return c.rejectTask(ctx, plan, err)
		}
		lockValue, _ := c.instanceMu.LoadOrStore(plan.InstanceRef, &sync.Mutex{})
		go func() {
			lock := lockValue.(*sync.Mutex)
			lock.Lock()
			defer lock.Unlock()
			c.executor.Execute(ctx, plan, func(state, kind, summary string, observed ...map[string]any) {
				payload := confirmedTaskEventPayload(plan, state, kind, summary, observed...)
				if err := c.send("task.event", payload); err != nil {
					log.Printf("task event delivery failed: %v", err)
				}
			})
			// A lifecycle provider can accept the write before its externally
			// observable state changes. Report a fresh authoritative inventory
			// immediately after execution so Cloud can converge the confirmed
			// outcome without waiting for the periodic inventory ticker.
			if err := c.reportInventory(ctx); err != nil {
				log.Printf("post-task inventory report failed: %v", err)
			}
		}()
		return nil
	default:
		return fmt.Errorf("unsupported message type %q", header.Type)
	}
}

func confirmedTaskEventPayload(plan protocol.TaskPlan, state, kind, summary string, observed ...map[string]any) map[string]any {
	payload := map[string]any{"task_id": plan.TaskID, "kind": kind, "summary": summary}
	if len(observed) == 1 && observed[0] != nil {
		payload["observed"] = observed[0]
	} else if kind == "plugin" {
		if observed, ok := resolvedPluginObservation(summary); ok {
			payload["observed"] = observed
		}
	}
	if state != "" {
		payload["state"] = state
	}
	confirmed := plan.ConfirmedOperation
	if confirmed == nil {
		return payload
	}
	var execute *protocol.ConfirmedOperationStep
	for index := range confirmed.Steps {
		if confirmed.Steps[index].Purpose != "execute" {
			continue
		}
		if execute != nil {
			return payload
		}
		execute = &confirmed.Steps[index]
	}
	if execute == nil {
		if kind == "console" {
			payload["command_outcome"] = executor.ClassifyConsoleCommandOutcome(summary)
			if len(plan.Steps) == 1 && plan.Steps[0].Tool == "console.command" {
				payload["step_id"] = plan.Steps[0].ID
				payload["tool"] = plan.Steps[0].Tool
			}
		}
		return payload
	}
	if kind == "console" {
		command, _ := execute.Parameters["command"].(string)
		payload["command_outcome"] = executor.ClassifyConsoleCommandOutcomeForCommand(command, summary, execute.Risk != "read")
	}
	payload["step_id"] = execute.ID
	payload["tool"] = execute.Tool
	payload["target"] = execute.Target
	payload["parameters"] = execute.Parameters
	payload["operation_digest"] = confirmed.OperationDigest
	payload["confirmation_digest"] = confirmed.SummaryDigest
	return payload
}

var pluginIntegrityPattern = regexp.MustCompile(`^[a-fA-F0-9]+$`)

// resolvedPluginObservation turns the executor-owned resolve receipt into typed
// evidence. Cloud must never recover install authority from user-facing text.
func resolvedPluginObservation(summary string) (map[string]any, bool) {
	const prefix = "Plugin resolve result: "
	if !strings.HasPrefix(summary, prefix) {
		return nil, false
	}
	fields := map[string]string{}
	for _, item := range strings.Split(strings.TrimPrefix(summary, prefix), "; ") {
		key, value, ok := strings.Cut(item, "=")
		if !ok || key == "" || value == "" && key != "sha256" || fields[key] != "" {
			return nil, false
		}
		fields[key] = value
	}
	for _, key := range []string{"project", "version", "source", "artifact", "compatibility", "sha256", "source_sha512"} {
		if _, ok := fields[key]; !ok {
			return nil, false
		}
	}
	if len(fields) != 7 || fields["project"] == "" || fields["artifact"] == "" || fields["source"] == "" {
		return nil, false
	}
	if fields["sha256"] != "" && (len(fields["sha256"]) != 64 || !pluginIntegrityPattern.MatchString(fields["sha256"])) {
		return nil, false
	}
	if fields["source_sha512"] != "" && (len(fields["source_sha512"]) != 128 || !pluginIntegrityPattern.MatchString(fields["source_sha512"])) {
		return nil, false
	}
	if fields["sha256"] == "" && fields["source_sha512"] == "" {
		return nil, false
	}
	return map[string]any{
		"schema_version": "resolved-plugin/v1",
		"project":        fields["project"],
		"version":        fields["version"],
		"source":         fields["source"],
		"artifact":       fields["artifact"],
		"compatibility":  fields["compatibility"],
		"sha256":         fields["sha256"],
		"source_sha512":  fields["source_sha512"],
	}, true
}

func (c *Connector) rejectTask(_ context.Context, plan protocol.TaskPlan, validationErr error) error {
	c.rejectionMu.Lock()
	if c.rejectedTasks == nil {
		c.rejectedTasks = map[string]bool{}
	}
	if c.rejectedTasks[plan.TaskID] {
		c.rejectionMu.Unlock()
		return nil
	}
	c.rejectedTasks[plan.TaskID] = true
	c.rejectionMu.Unlock()
	reason := validationErr.Error()
	if len(reason) > 240 {
		reason = reason[:240]
	}
	payload := map[string]any{
		"task_id": plan.TaskID, "state": "REJECTED", "kind": "validation", "stage": "validation",
		"code": "PLAN_VALIDATION_REJECTED", "summary": reason, "provider_calls": 0, "tool_calls": 0,
		"at": time.Now().UTC().Format(time.RFC3339Nano),
	}
	var err error
	if c.sendMessage != nil {
		err = c.sendMessage("task.event", payload)
	} else {
		err = c.send("task.event", payload)
	}
	if err != nil {
		c.rejectionMu.Lock()
		delete(c.rejectedTasks, plan.TaskID)
		c.rejectionMu.Unlock()
		return err
	}
	return nil
}

func (c *Connector) reportInventory(ctx context.Context) error {
	if c.tenantID == "" {
		return nil
	}
	instances, err := c.collect(ctx)
	if err != nil {
		return err
	}
	return c.send("inventory.report", map[string]any{"instances": instances})
}

func (c *Connector) send(messageType string, payload any) error {
	message, err := protocol.NewEnvelope(c.identity, c.tenantID, randomID(), randomID(), messageType, payload)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.conn == nil {
		return errors.New("gateway is not connected")
	}
	c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteJSON(message)
}

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprint(time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
