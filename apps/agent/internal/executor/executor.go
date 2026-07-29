package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/mcai/sidecar-agent/internal/audit"
	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
	"github.com/mcai/sidecar-agent/internal/security"
)

type EventSink func(state, kind, summary string)

type Executor struct {
	providers       map[string]provider.Provider
	dataDir         string
	audit           *audit.Writer
	releaseResolver releaseResolver
}

const paper1211URL = "https://fill-data.papermc.io/v1/objects/39bd8c00b9e18de91dcabd3cc3dcfa5328685a53b7187a2f63280c22e2d287b9/paper-1.21.1-133.jar"

func New(dataDir string, auditWriter *audit.Writer) *Executor {
	return NewWithReleaseResolver(dataDir, auditWriter, newOfficialReleaseResolver())
}

func NewWithReleaseResolver(dataDir string, auditWriter *audit.Writer, resolver releaseResolver) *Executor {
	if resolver == nil {
		resolver = newOfficialReleaseResolver()
	}
	return &Executor{providers: make(map[string]provider.Provider), dataDir: dataDir, audit: auditWriter, releaseResolver: resolver}
}

func (e *Executor) Register(prefix string, p provider.Provider) { e.providers[prefix] = p }

func (e *Executor) Execute(ctx context.Context, plan protocol.TaskPlan, emit EventSink) {
	p, err := e.resolve(plan.InstanceRef)
	if err != nil {
		emit("", "diagnosis", classifyFailure(err.Error(), "", ""))
		emit("FAILED", "policy", err.Error())
		return
	}
	current, err := p.GetInstance(ctx, plan.InstanceRef)
	if err != nil {
		emit("", "diagnosis", classifyFailure(err.Error(), "", "unknown"))
		emit("FAILED", "inventory", "Could not refresh instance revision: "+err.Error())
		return
	}
	if current.ProfileRevision != plan.InventoryRevision {
		emit("", "diagnosis", "实例信息在计划生成后发生了变化；为避免对错误版本执行操作，Agent 已拒绝继续。")
		emit("FAILED", "policy", "Inventory revision is stale; refresh before retrying")
		return
	}
	if _, err := e.audit.Append("task.execution.started", plan.TaskID, plan.Intent, map[string]any{"instance_ref": plan.InstanceRef}); err != nil {
		emit("", "diagnosis", "本地审计记录无法写入；安全策略禁止在缺少审计证据时继续执行。")
		emit("FAILED", "audit", "Local audit write failed; refusing execution")
		return
	}
	emit("EXECUTING", "state", "Execution started after local policy checks")
	for _, step := range plan.Steps {
		if err := e.executeStep(ctx, p, plan, step, emit); err != nil {
			e.audit.Append("tool.execution.failed", plan.TaskID, err.Error(), map[string]any{"tool": step.Tool})
			emit("", "diagnosis", e.diagnoseFailure(ctx, p, plan.InstanceRef, err))
			emit("FAILED", "tool", fmt.Sprintf("%s failed: %v", step.Tool, err))
			return
		}
	}
	emit("VERIFYING", "state", "All steps committed; checking acceptance signals")
	if err := e.verify(ctx, p, plan); err != nil {
		emit("", "diagnosis", e.diagnoseFailure(ctx, p, plan.InstanceRef, err))
		emit("FAILED", "verification", err.Error())
		return
	}
	e.audit.Append("tool.execution.verified", plan.TaskID, "All deterministic acceptance checks passed", nil)
	emit("SUCCEEDED", "verification", "All deterministic acceptance checks passed")
}

func (e *Executor) diagnoseFailure(ctx context.Context, p provider.Provider, instanceRef string, cause error) string {
	state := "unknown"
	if instance, err := p.GetInstance(ctx, instanceRef); err == nil {
		state = instance.State
	}
	output := ""
	if collected, err := p.ReadOutput(ctx, instanceRef, 160); err == nil {
		if len(collected) > 64*1024 {
			collected = collected[len(collected)-64*1024:]
		}
		output = collected
	}
	return classifyFailure(cause.Error(), output, state)
}

func classifyFailure(cause, output, state string) string {
	combined := strings.ToLower(cause + "\n" + output)
	switch {
	case strings.Contains(combined, "eula") || strings.Contains(combined, "agree to the eula"):
		return "服务器未接受 Minecraft EULA，进程因此拒绝启动。"
	case strings.Contains(combined, "address already in use") || strings.Contains(combined, "failed to bind to port") || strings.Contains(combined, "bind exception"):
		return "服务器端口已被其他进程占用，Minecraft 无法完成端口绑定。"
	case strings.Contains(combined, "unsupportedclassversionerror") || strings.Contains(combined, "only recognizes class file") || strings.Contains(combined, "could not create the java virtual machine"):
		return "Java 运行时与服务端核心或插件要求不兼容。"
	case strings.Contains(combined, "outofmemoryerror") || strings.Contains(combined, "cannot allocate memory") || strings.Contains(combined, "insufficient memory"):
		return "Java 进程内存不足，或启动参数申请的内存超过当前可用资源。"
	case strings.Contains(combined, "unable to access jarfile") || strings.Contains(combined, "invalid or corrupt jarfile") || strings.Contains(combined, "could not find or load main class"):
		return "启动 JAR 缺失、路径错误或文件已损坏。"
	case strings.Contains(combined, "permission denied") || strings.Contains(combined, "accessdeniedexception"):
		return "实例目录或启动文件权限不足，运行用户无法读取或写入所需文件。"
	case strings.Contains(combined, "mod resolution encountered") || strings.Contains(combined, "missing mandatory dependencies") || strings.Contains(combined, "requires version"):
		return "模组或插件依赖不完整，存在缺失项或版本冲突。"
	case strings.Contains(combined, "exception in server tick loop") || strings.Contains(combined, "crash report") || strings.Contains(combined, "a fatal error"):
		return "Minecraft 进程发生运行时崩溃，需要结合崩溃报告定位具体模组、插件或配置。"
	case state == "stopped" && (strings.Contains(combined, "did not reach running") || strings.Contains(combined, "start request") || strings.Contains(combined, "start timeout")):
		return "启动请求已经发出，但实例仍处于停止状态；面板启动参数、核心文件或运行环境可能存在错误。"
	default:
		return "工具返回错误：" + sanitizeDiagnostic(cause)
	}
}

var sensitiveDiagnostic = regexp.MustCompile(`(?i)(api[_ -]?key|token|secret|password)\s*[:=]\s*\S+`)

func sanitizeDiagnostic(value string) string {
	value = sensitiveDiagnostic.ReplaceAllString(value, "$1=[REDACTED]")
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return "未返回可识别的错误信息，请检查实例控制台日志。"
	}
	if len(value) > 220 {
		value = value[:220] + "…"
	}
	return value
}

func (e *Executor) executeStep(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	switch step.Tool {
	case "logs.query":
		output, err := p.ReadOutput(ctx, plan.InstanceRef, 256)
		if err != nil {
			return err
		}
		if len(output) > 256*1024 {
			output = output[len(output)-256*1024:]
		}
		sum := sha256.Sum256([]byte(output))
		emit("", "logs", fmt.Sprintf("Collected %d bytes of logs (sha256:%s)", len(output), hex.EncodeToString(sum[:8])))
		return nil
	case "files.list":
		target := stringArg(step.Args, "path")
		if target == "" {
			target = "/"
		}
		listing, err := p.ListFiles(ctx, plan.InstanceRef, target)
		if err != nil {
			return err
		}
		if len(listing) > 64*1024 {
			listing = listing[:64*1024] + "…"
		}
		emit("", "files", "实例目录 "+target+"： "+listing)
		return nil
	case "server.install":
		return e.installServer(ctx, p, plan, step, emit)
	case "file.download":
		return errors.New("direct file downloads are not enabled; use the controlled server.install operation")
	case "config.patch":
		return e.configPatch(ctx, p, plan, step, emit)
	case "instance.start":
		if err := p.Start(ctx, plan.InstanceRef); err != nil {
			return err
		}
		emit("", "instance", "Start request accepted by the panel")
		return nil
	case "instance.restart":
		if err := p.Restart(ctx, plan.InstanceRef); err != nil {
			return err
		}
		emit("", "instance", "Restart request accepted by the panel")
		return nil
	case "plugin.resolve", "plugin.install":
		return errors.New("plugin workflow is not enabled in this agent build")
	default:
		return fmt.Errorf("tool %q is not registered", step.Tool)
	}
}

func (e *Executor) downloadPaper1211(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	sourceURL := stringArg(step.Args, "url")
	target := stringArg(step.Args, "target")
	if sourceURL != paper1211URL || target != "/server.jar" {
		return errors.New("only the pinned official Paper 1.21.1 artifact may be downloaded to /server.jar")
	}
	if err := p.DownloadFromURL(ctx, plan.InstanceRef, sourceURL, target); err != nil {
		return err
	}
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		listing, err := p.ListFiles(ctx, plan.InstanceRef, "/")
		if err == nil && strings.Contains(listing, "server.jar") {
			emit("", "download", "已从 Paper 官方源下载 1.21.1 build 133，并保存为 /server.jar。")
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return errors.New("download did not produce /server.jar within two minutes")
}

func (e *Executor) installServer(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	platform := stringArg(step.Args, "platform")
	minecraftVersion := stringArg(step.Args, "minecraft_version")
	target := stringArg(step.Args, "target")
	if target != "/server.jar" {
		return errors.New("server installer may only write /server.jar")
	}
	instance, err := p.GetInstance(ctx, plan.InstanceRef)
	if err != nil {
		return err
	}
	if instance.State != "stopped" {
		return fmt.Errorf("server installation requires a stopped instance; current state is %s", instance.State)
	}
	artifact, err := e.releaseResolver.Resolve(ctx, platform, minecraftVersion)
	if err != nil {
		return err
	}
	if err := p.DownloadFromURL(ctx, plan.InstanceRef, artifact.URL, target); err != nil {
		return err
	}
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		listing, err := p.ListFiles(ctx, plan.InstanceRef, "/")
		if err == nil && strings.Contains(listing, "server.jar") {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	listing, err := p.ListFiles(ctx, plan.InstanceRef, "/")
	if err != nil || !strings.Contains(listing, "server.jar") {
		return errors.New("official download did not produce /server.jar within three minutes")
	}
	emit("", "download", fmt.Sprintf("Downloaded official %s %s release %s to /server.jar", artifact.Platform, artifact.MinecraftVersion, artifact.Name))
	if err := p.UpdateStartConfig(ctx, plan.InstanceRef, provider.StartConfig{
		StartCommand: "/usr/bin/java -Xms512M -Xmx2G -jar server.jar nogui",
		StopCommand:  "stop",
		StopTimeout:  30,
	}); err != nil {
		return fmt.Errorf("configure Minecraft start command: %w", err)
	}
	emit("", "instance", "Configured the Minecraft start command")
	if err := p.Start(ctx, plan.InstanceRef); err != nil {
		return err
	}
	emit("", "instance", "Start request accepted by the panel")
	return nil
}

func (e *Executor) configPatch(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	target, err := security.NormalizeRelative(stringArg(step.Args, "path"))
	if err != nil {
		return err
	}
	before, err := p.ReadFile(ctx, plan.InstanceRef, target)
	if err != nil {
		return err
	}
	if len(before) > 2<<20 {
		return errors.New("configuration file exceeds the 2 MiB limit")
	}
	patches, ok := step.Args["patch"].([]any)
	if !ok || len(patches) != 1 {
		return errors.New("exactly one structured property patch is required")
	}
	patch, ok := patches[0].(map[string]any)
	if !ok || stringArg(patch, "op") != "replace" {
		return errors.New("unsupported patch operation")
	}
	after, err := patchProperties(before, stringArg(patch, "key"), patch["value"])
	if err != nil {
		return err
	}
	snapshotDir := filepath.Join(e.dataDir, "snapshots", plan.TaskID)
	if err := os.MkdirAll(snapshotDir, 0o700); err != nil {
		return err
	}
	snapshotPath := filepath.Join(snapshotDir, strings.ReplaceAll(strings.TrimPrefix(target, "/"), "/", "_"))
	if err := os.WriteFile(snapshotPath, before, 0o600); err != nil {
		return fmt.Errorf("snapshot: %w", err)
	}
	beforeHash, afterHash := sha256.Sum256(before), sha256.Sum256(after)
	emit("", "snapshot", fmt.Sprintf("Created S1 snapshot %s", filepath.Base(snapshotPath)))
	if err := p.WriteFile(ctx, plan.InstanceRef, target, after); err != nil {
		return err
	}
	readBack, err := p.ReadFile(ctx, plan.InstanceRef, target)
	if err != nil || sha256.Sum256(readBack) != afterHash {
		if restoreErr := p.WriteFile(ctx, plan.InstanceRef, target, before); restoreErr != nil {
			return fmt.Errorf("verification failed and rollback failed: %v", restoreErr)
		}
		return errors.New("semantic read-back failed; the original snapshot was restored")
	}
	e.audit.Append("config.patch.committed", plan.TaskID, target, map[string]any{"before_sha256": hex.EncodeToString(beforeHash[:]), "after_sha256": hex.EncodeToString(afterHash[:])})
	emit("", "config", fmt.Sprintf("Patched %s and verified sha256:%s", target, hex.EncodeToString(afterHash[:8])))
	return nil
}

func (e *Executor) verify(ctx context.Context, p provider.Provider, plan protocol.TaskPlan) error {
	for _, rule := range plan.Acceptance {
		if rule.Type == "instance_state" {
			deadline := time.Now().Add(2 * time.Minute)
			for time.Now().Before(deadline) {
				instance, err := p.GetInstance(ctx, plan.InstanceRef)
				if err == nil && instance.State == rule.Expected {
					break
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(2 * time.Second):
				}
			}
			instance, err := p.GetInstance(ctx, plan.InstanceRef)
			if err != nil || instance.State != rule.Expected {
				return fmt.Errorf("instance did not reach %s", rule.Expected)
			}
		}
		if rule.Type == "server_ready" {
			deadline := time.Now().Add(3 * time.Minute)
			for time.Now().Before(deadline) {
				instance, instanceErr := p.GetInstance(ctx, plan.InstanceRef)
				output, outputErr := p.ReadOutput(ctx, plan.InstanceRef, 256)
				if outputErr == nil && isServerReady(output) && instanceErr == nil && instance.State == "running" {
					break
				}
				if outputErr == nil && strings.Contains(strings.ToLower(output), "eula") {
					return errors.New("server requires Minecraft EULA acceptance before it can start")
				}
				if instanceErr == nil && instance.State == "stopped" {
					return errors.New("server stopped before reaching its ready signal")
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(2 * time.Second):
				}
			}
			instance, instanceErr := p.GetInstance(ctx, plan.InstanceRef)
			output, outputErr := p.ReadOutput(ctx, plan.InstanceRef, 256)
			if instanceErr != nil || outputErr != nil || instance.State != "running" || !isServerReady(output) {
				return errors.New("server did not reach the Minecraft ready signal within three minutes")
			}
		}
	}
	return nil
}

func isServerReady(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "done (") || strings.Contains(lower, "for help, type \"help\"")
}

func (e *Executor) resolve(ref string) (provider.Provider, error) {
	prefix := strings.SplitN(ref, ":", 2)[0]
	p := e.providers[prefix]
	if p == nil {
		return nil, fmt.Errorf("no provider registered for %q", prefix)
	}
	return p, nil
}

func stringArg(args map[string]any, key string) string { value, _ := args[key].(string); return value }
