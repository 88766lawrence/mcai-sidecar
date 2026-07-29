package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Cloud struct {
		GatewayURL string `yaml:"gateway_url"`
		TenantID  string `yaml:"tenant_id"`
	} `yaml:"cloud"`
	DataDir           string           `yaml:"data_dir"`
	DisplayName       string           `yaml:"display_name"`
	InventoryInterval time.Duration    `yaml:"-"`
	InventoryRaw      string           `yaml:"inventory_interval"`
	Providers         []ProviderConfig `yaml:"providers"`
}

type ProviderConfig struct {
	ID        string   `yaml:"id"`
	Type      string   `yaml:"type"`
	Endpoint  string   `yaml:"endpoint"`
	DaemonIDs []string `yaml:"daemon_ids"`
	APIKey    string   `yaml:"-"`
}

type credentials struct {
	Providers map[string]struct {
		APIKey string `yaml:"api_key"`
	} `yaml:"providers"`
}

func Load(path string) (Config, error) {
	var cfg Config
	b, err := os.ReadFile(path)
	if err != nil { return cfg, fmt.Errorf("read config: %w", err) }
	if err := yaml.Unmarshal(b, &cfg); err != nil { return cfg, fmt.Errorf("parse config: %w", err) }
	if cfg.Cloud.GatewayURL == "" || cfg.DataDir == "" { return cfg, errors.New("cloud.gateway_url and data_dir are required") }
	if cfg.DisplayName == "" { cfg.DisplayName = "mcai-agent" }
	cfg.InventoryInterval = 5 * time.Minute
	if cfg.InventoryRaw != "" {
		if parsed, err := time.ParseDuration(cfg.InventoryRaw); err == nil { cfg.InventoryInterval = parsed } else { return cfg, fmt.Errorf("inventory_interval: %w", err) }
	}
	credPath := filepath.Join(filepath.Dir(path), "credentials.yaml")
	credBytes, err := os.ReadFile(credPath)
	if err != nil { return cfg, fmt.Errorf("read credentials: %w", err) }
	var creds credentials
	if err := yaml.Unmarshal(credBytes, &creds); err != nil { return cfg, fmt.Errorf("parse credentials: %w", err) }
	for i := range cfg.Providers {
		cfg.Providers[i].APIKey = creds.Providers[cfg.Providers[i].ID].APIKey
		if cfg.Providers[i].APIKey == "" { return cfg, fmt.Errorf("missing credential for provider %q", cfg.Providers[i].ID) }
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil { return cfg, fmt.Errorf("create data directory: %w", err) }
	return cfg, nil
}

