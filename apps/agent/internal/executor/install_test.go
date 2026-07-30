package executor

import (
	"context"
	"strings"
	"testing"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

type resolverFunc func(context.Context, string, string) (releaseArtifact, error)

func (f resolverFunc) Resolve(ctx context.Context, platform, minecraftVersion string) (releaseArtifact, error) {
	return f(ctx, platform, minecraftVersion)
}

type installProvider struct {
	instance   provider.Instance
	downloaded string
	configured provider.StartConfig
	started    bool
	files      map[string][]byte
}

func (p *installProvider) ListInstances(context.Context) ([]provider.Instance, error) {
	return []provider.Instance{p.instance}, nil
}
func (p *installProvider) ReadOutput(context.Context, string, int) (string, error) { return "", nil }
func (p *installProvider) ListFiles(context.Context, string, string) (string, error) {
	return p.downloaded, nil
}
func (p *installProvider) DownloadFromURL(_ context.Context, _ string, sourceURL, fileName string) error {
	p.downloaded = fileName
	if sourceURL == "" {
		return context.Canceled
	}
	return nil
}
func (p *installProvider) UpdateStartConfig(_ context.Context, _ string, config provider.StartConfig) error {
	p.configured = config
	return nil
}
func (p *installProvider) ReadFile(_ context.Context, _ string, path string) ([]byte, error) {
	return p.files[path], nil
}
func (p *installProvider) WriteFile(_ context.Context, _ string, path string, contents []byte) error {
	if p.files == nil {
		p.files = make(map[string][]byte)
	}
	p.files[path] = append([]byte(nil), contents...)
	return nil
}
func (p *installProvider) Start(context.Context, string) error {
	p.started = true
	return nil
}
func (p *installProvider) Restart(context.Context, string) error { return nil }
func (p *installProvider) GetInstance(context.Context, string) (provider.Instance, error) {
	return p.instance, nil
}

func TestInstallServerDownloadsConfiguresAndStarts(t *testing.T) {
	p := &installProvider{instance: provider.Instance{State: "stopped"}}
	executor := NewWithReleaseResolver("", nil, resolverFunc(func(_ context.Context, platform, minecraftVersion string) (releaseArtifact, error) {
		if platform != "fabric" || minecraftVersion != "1.20.4" {
			t.Fatalf("unexpected release lookup %q %q", platform, minecraftVersion)
		}
		return releaseArtifact{Platform: platform, MinecraftVersion: minecraftVersion, URL: "https://meta.fabricmc.net/server.jar", Name: "fabric-server-launch.jar"}, nil
	}))
	plan := protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}
	step := protocol.TaskStep{Tool: "server.install", Args: map[string]any{
		"platform": "fabric", "minecraft_version": "1.20.4", "target": "/server.jar", "accept_eula": true,
	}}

	if err := executor.installServer(context.Background(), p, plan, step, func(_, _, _ string) {}); err != nil {
		t.Fatal(err)
	}
	if p.downloaded != "/server.jar" || !p.started {
		t.Fatalf("installer did not download and start: %#v", p)
	}
	if !hasAcceptedEULA(p.files["eula.txt"]) {
		t.Fatal("installer did not persist verified EULA acceptance")
	}
	if p.configured.StartCommand != "/usr/bin/java -Xms512M -Xmx2G -jar server.jar nogui" || p.configured.StopCommand != "stop" || p.configured.StopTimeout != 30 {
		t.Fatalf("unexpected start config: %#v", p.configured)
	}
}

func TestInstallServerRequiresExplicitEULAAcceptance(t *testing.T) {
	p := &installProvider{instance: provider.Instance{State: "stopped"}}
	executor := NewWithReleaseResolver("", nil, resolverFunc(func(_ context.Context, platform, minecraftVersion string) (releaseArtifact, error) {
		return releaseArtifact{Platform: platform, MinecraftVersion: minecraftVersion, URL: "https://fill-data.papermc.io/v1/objects/test/server.jar", Name: "server.jar"}, nil
	}))
	err := executor.installServer(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{Args: map[string]any{
		"platform": "paper", "minecraft_version": "1.21.1", "target": "/server.jar", "accept_eula": false,
	}}, func(_, _, _ string) {})
	if err == nil || !strings.Contains(err.Error(), "explicitly agree") {
		t.Fatalf("expected explicit EULA consent error, got %v", err)
	}
	if p.started {
		t.Fatal("server must not start before explicit EULA acceptance")
	}
}

func TestInstallServerRequiresStoppedInstance(t *testing.T) {
	p := &installProvider{instance: provider.Instance{State: "running"}}
	executor := NewWithReleaseResolver("", nil, resolverFunc(func(context.Context, string, string) (releaseArtifact, error) {
		t.Fatal("resolver must not run for a live server")
		return releaseArtifact{}, nil
	}))
	err := executor.installServer(context.Background(), p, protocol.TaskPlan{InstanceRef: "mcs:daemon:instance"}, protocol.TaskStep{Args: map[string]any{
		"platform": "paper", "minecraft_version": "1.21.1", "target": "/server.jar",
	}}, func(_, _, _ string) {})
	if err == nil {
		t.Fatal("expected a running instance to be rejected")
	}
}
