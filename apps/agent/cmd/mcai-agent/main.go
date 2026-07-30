package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/mcai/sidecar-agent/internal/audit"
	"github.com/mcai/sidecar-agent/internal/config"
	"github.com/mcai/sidecar-agent/internal/connector"
	"github.com/mcai/sidecar-agent/internal/executor"
	"github.com/mcai/sidecar-agent/internal/identity"
	"github.com/mcai/sidecar-agent/internal/provider"
	"github.com/mcai/sidecar-agent/internal/provider/mcsmanager"
)

func main() {
	configPath := flag.String("config", "/etc/mcai/agent.yaml", "path to agent configuration")
	flag.Parse()
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	id, err := identity.LoadOrCreate(cfg.DataDir)
	if err != nil {
		log.Fatal(err)
	}
	auditWriter, err := audit.New(cfg.DataDir)
	if err != nil {
		log.Fatal(err)
	}
	exec := executor.New(cfg.DataDir, auditWriter)
	providers := make([]provider.Provider, 0, len(cfg.Providers))
	for _, item := range cfg.Providers {
		if item.Type != "mcsmanager" {
			log.Printf("provider %s skipped: type %s is not enabled", item.ID, item.Type)
			continue
		}
		client, createErr := mcsmanager.New(item.Endpoint, item.APIKey, item.DaemonIDs)
		if createErr != nil {
			log.Fatalf("provider %s: %v", item.ID, createErr)
		}
		exec.Register("mcs", client)
		providers = append(providers, client)
	}
	collect := func(ctx context.Context) ([]provider.Instance, error) {
		var all []provider.Instance
		var failures []string
		for _, p := range providers {
			list, listErr := p.ListInstances(ctx)
			if listErr != nil {
				failures = append(failures, listErr.Error())
				continue
			}
			all = append(all, list...)
		}
		if len(failures) > 0 && len(all) == 0 {
			return nil, fmt.Errorf("inventory failed: %s", strings.Join(failures, "; "))
		}
		return all, nil
	}
	client, err := connector.New(cfg.Cloud.GatewayURL, cfg.Cloud.TenantID, cfg.DisplayName, id, exec, collect, cfg.InventoryInterval)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("mcai-agent %s starting", id.AgentID)
	if err := client.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
