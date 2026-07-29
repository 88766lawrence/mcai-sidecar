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
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mcai/sidecar-agent/internal/executor"
	"github.com/mcai/sidecar-agent/internal/identity"
	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

type Connector struct {
	gatewayURL  string
	tenantID   string
	displayName string
	identity    *identity.Identity
	executor    *executor.Executor
	collect     func(context.Context) ([]provider.Instance, error)
	writeMu     sync.Mutex
	conn        *websocket.Conn
	instanceMu  sync.Map
}

func New(gatewayURL, tenantID, displayName string, id *identity.Identity, exec *executor.Executor, collect func(context.Context) ([]provider.Instance, error)) (*Connector, error) {
	u, err := url.Parse(gatewayURL)
	if err != nil { return nil, err }
	if u.Scheme != "wss" && !(u.Scheme == "ws" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1")) { return nil, errors.New("gateway must use WSS (WS is allowed only for localhost)") }
	return &Connector{gatewayURL: gatewayURL, tenantID: tenantID, displayName: displayName, identity: id, executor: exec, collect: collect}, nil
}

func (c *Connector) Run(ctx context.Context) error {
	backoff := time.Second
	for ctx.Err() == nil {
		if err := c.runSession(ctx); err != nil { log.Printf("gateway session ended: %v", err) }
		select { case <-ctx.Done(): return ctx.Err(); case <-time.After(backoff): }
		if backoff < 30*time.Second { backoff *= 2 }
	}
	return ctx.Err()
}

func (c *Connector) runSession(ctx context.Context) error {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, c.gatewayURL, nil)
	if err != nil { return err }
	defer conn.Close()
	c.conn = conn
	hello := map[string]any{"public_key": c.identity.PublicKeyString(), "display_name": c.displayName, "version": "0.1.0"}
	if c.tenantID == "" {
		hello["pairing_code"] = c.identity.PairingCode
		log.Printf("pairing code: %s", c.identity.PairingCode)
	}
	if err := c.send("agent.hello", hello); err != nil { return err }
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	done := make(chan error, 1)
	go func() {
		for {
			_, raw, readErr := conn.ReadMessage()
			if readErr != nil { done <- readErr; return }
			if handleErr := c.handle(ctx, raw); handleErr != nil { log.Printf("rejected gateway message: %v", handleErr) }
		}
	}()
	for {
		select {
		case <-ctx.Done(): return ctx.Err()
		case err := <-done: return err
		case <-heartbeat.C:
			if err := c.send("heartbeat", map[string]any{"at": time.Now().UTC()}); err != nil { return err }
		}
	}
}

func (c *Connector) handle(ctx context.Context, raw []byte) error {
	var header struct {
		Type string `json:"type"`
		TenantID string `json:"tenant_id"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &header); err != nil { return err }
	switch header.Type {
	case "agent.welcome":
		if header.TenantID != "" { c.tenantID = header.TenantID }
		return c.reportInventory(ctx)
	case "agent.paired":
		if header.TenantID == "" { return errors.New("paired message omitted tenant") }
		c.tenantID = header.TenantID
		return c.reportInventory(ctx)
	case "task.execute":
		var plan protocol.TaskPlan
		if err := json.Unmarshal(header.Payload, &plan); err != nil { return err }
		if plan.SchemaVersion != "task-plan/v1" || plan.TaskID == "" || plan.InstanceRef == "" { return errors.New("invalid task plan") }
		lockValue, _ := c.instanceMu.LoadOrStore(plan.InstanceRef, &sync.Mutex{})
		go func() {
			lock := lockValue.(*sync.Mutex); lock.Lock(); defer lock.Unlock()
			c.executor.Execute(ctx, plan, func(state, kind, summary string) {
				payload := map[string]any{"task_id": plan.TaskID, "kind": kind, "summary": summary}
				if state != "" { payload["state"] = state }
				if err := c.send("task.event", payload); err != nil { log.Printf("task event delivery failed: %v", err) }
			})
		}()
		return nil
	default:
		return fmt.Errorf("unsupported message type %q", header.Type)
	}
}

func (c *Connector) reportInventory(ctx context.Context) error {
	if c.tenantID == "" { return nil }
	instances, err := c.collect(ctx); if err != nil { return err }
	return c.send("inventory.report", map[string]any{"instances": instances})
}

func (c *Connector) send(messageType string, payload any) error {
	message, err := protocol.NewEnvelope(c.identity, c.tenantID, randomID(), randomID(), messageType, payload)
	if err != nil { return err }
	c.writeMu.Lock(); defer c.writeMu.Unlock()
	if c.conn == nil { return errors.New("gateway is not connected") }
	c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteJSON(message)
}

func randomID() string { b := make([]byte, 16); if _, err := rand.Read(b); err != nil { return fmt.Sprint(time.Now().UnixNano()) }; return hex.EncodeToString(b) }
