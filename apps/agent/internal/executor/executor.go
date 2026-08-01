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
	"unicode"

	"github.com/mcai/sidecar-agent/internal/audit"
	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
	"github.com/mcai/sidecar-agent/internal/security"
)

type EventSink func(state, kind, summary string)

type Executor struct {
	providers        map[string]provider.Provider
	dataDir          string
	audit            *audit.Writer
	releaseResolver  releaseResolver
	pluginResolver   pluginResolver
	maxAttempts      int
	retryDelay       func(int) time.Duration
	consolePollDelay time.Duration
}

const paper1211URL = "https://fill-data.papermc.io/v1/objects/39bd8c00b9e18de91dcabd3cc3dcfa5328685a53b7187a2f63280c22e2d287b9/paper-1.21.1-133.jar"
const defaultMaxAttempts = 4

func New(dataDir string, auditWriter *audit.Writer) *Executor {
	return NewWithReleaseResolver(dataDir, auditWriter, newOfficialReleaseResolver())
}

func NewWithReleaseResolver(dataDir string, auditWriter *audit.Writer, resolver releaseResolver) *Executor {
	if resolver == nil {
		resolver = newOfficialReleaseResolver()
	}
	return &Executor{
		providers:        make(map[string]provider.Provider),
		dataDir:          dataDir,
		audit:            auditWriter,
		releaseResolver:  resolver,
		pluginResolver:   newOfficialPluginResolver(),
		maxAttempts:      defaultMaxAttempts,
		consolePollDelay: 250 * time.Millisecond,
		retryDelay: func(attempt int) time.Duration {
			return time.Duration(1<<min(attempt-1, 3)) * time.Second
		},
	}
}

func (e *Executor) Register(prefix string, p provider.Provider) { e.providers[prefix] = p }

func (e *Executor) Execute(ctx context.Context, plan protocol.TaskPlan, emit EventSink) {
	p, err := e.resolve(plan.InstanceRef)
	if err != nil {
		emit("", "diagnosis", classifyFailure(err.Error(), "", ""))
		emit("FAILED", "policy", err.Error())
		return
	}
	current, err := e.refreshInstance(ctx, p, plan, emit)
	if err != nil {
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
		if err := e.executeStepWithRecovery(ctx, p, plan, step, emit); err != nil {
			e.audit.Append("tool.execution.failed", plan.TaskID, err.Error(), map[string]any{"tool": step.Tool})
			if planHasTool(plan, "plugin.install") {
				e.rollbackPlugin(ctx, p, plan, emit)
			}
			emit("FAILED", "tool", fmt.Sprintf("%s failed: %v", step.Tool, err))
			return
		}
	}
	emit("VERIFYING", "state", "All steps committed; checking acceptance signals")
	for attempt := 1; ; attempt++ {
		if err := e.verify(ctx, p, plan); err != nil {
			diagnosis := e.diagnoseFailure(ctx, p, plan.InstanceRef, err)
			emit("", "diagnosis", diagnosis)
			lastStep, canRecover := finalAutonomousStep(plan.Steps)
			if !canRecover || attempt >= e.maxAttempts || ctx.Err() != nil || !isRetriableFailure(err.Error(), diagnosis) {
				if planHasTool(plan, "plugin.install") {
					e.rollbackPlugin(ctx, p, plan, emit)
				}
				emit("FAILED", "verification", err.Error())
				return
			}
			recoveryStep := verificationRecoveryStep(lastStep)
			emit("", "recovery", fmt.Sprintf("验收返回暂时性失败；正在重新调用 %s 并再次验收（第 %d/%d 次）", recoveryStep.Tool, attempt+1, e.maxAttempts))
			if err := e.waitBeforeRetry(ctx, attempt); err != nil {
				emit("FAILED", "verification", err.Error())
				return
			}
			if err := e.executeStepWithRecovery(ctx, p, plan, recoveryStep, emit); err != nil {
				e.audit.Append("tool.recovery.failed", plan.TaskID, err.Error(), map[string]any{"tool": recoveryStep.Tool})
				emit("FAILED", "tool", fmt.Sprintf("%s recovery failed: %v", recoveryStep.Tool, err))
				return
			}
			continue
		}
		break
	}
	e.audit.Append("tool.execution.verified", plan.TaskID, "All deterministic acceptance checks passed", nil)
	emit("SUCCEEDED", "verification", "All deterministic acceptance checks passed")
}

func (e *Executor) refreshInstance(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, emit EventSink) (provider.Instance, error) {
	var lastErr error
	for attempt := 1; attempt <= e.maxAttempts; attempt++ {
		current, err := p.GetInstance(ctx, plan.InstanceRef)
		if err == nil {
			return current, nil
		}
		lastErr = err
		diagnosis := classifyFailure(err.Error(), "", "unknown")
		emit("", "diagnosis", diagnosis)
		if attempt >= e.maxAttempts || ctx.Err() != nil || !isRetriableFailure(err.Error(), diagnosis) {
			break
		}
		emit("", "recovery", fmt.Sprintf("实例清单读取出现暂时性错误，正在自动重试（第 %d/%d 次）", attempt+1, e.maxAttempts))
		if waitErr := e.waitBeforeRetry(ctx, attempt); waitErr != nil {
			return provider.Instance{}, waitErr
		}
	}
	return provider.Instance{}, lastErr
}

func (e *Executor) executeStepWithRecovery(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	for attempt := 1; attempt <= e.maxAttempts; attempt++ {
		err := e.executeStep(ctx, p, plan, step, emit)
		if err == nil {
			return nil
		}
		diagnosis := e.diagnoseFailure(ctx, p, plan.InstanceRef, err)
		emit("", "diagnosis", diagnosis)
		if !autonomousRetrySafe(step) || attempt >= e.maxAttempts || ctx.Err() != nil || !isRetriableFailure(err.Error(), diagnosis) {
			return err
		}
		emit("", "recovery", fmt.Sprintf("%s 返回暂时性错误，正在自动重试（第 %d/%d 次）", step.Tool, attempt+1, e.maxAttempts))
		if waitErr := e.waitBeforeRetry(ctx, attempt); waitErr != nil {
			return waitErr
		}
	}
	return errors.New("automatic recovery exhausted without a result")
}

func (e *Executor) waitBeforeRetry(ctx context.Context, attempt int) error {
	delay := e.retryDelay(attempt)
	if delay <= 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func autonomousRetrySafe(step protocol.TaskStep) bool {
	return !step.RequiresConfirmation && (step.Risk == "read" || step.Risk == "low")
}

func finalAutonomousStep(steps []protocol.TaskStep) (protocol.TaskStep, bool) {
	if len(steps) == 0 {
		return protocol.TaskStep{}, false
	}
	last := steps[len(steps)-1]
	return last, autonomousRetrySafe(last)
}

func verificationRecoveryStep(step protocol.TaskStep) protocol.TaskStep {
	if step.Tool == "server.install" {
		return protocol.TaskStep{
			ID:   step.ID + "-start-recovery",
			Tool: "instance.start",
			Args: map[string]any{"timeout_seconds": 120},
			Risk: "low",
		}
	}
	return step
}

func isRetriableFailure(cause, diagnosis string) bool {
	combined := strings.ToLower(cause + "\n" + diagnosis)
	terminalSignals := []string{
		"eula", "address already in use", "failed to bind", "unsupportedclassversion",
		"outofmemory", "permission denied", "accessdenied", "invalid or corrupt jar",
		"not registered", "not enabled", "unsupported server platform", "requires a stopped instance",
		"inventory revision", "audit write", "forbidden", "端口", "内存", "权限", "依赖",
	}
	for _, signal := range terminalSignals {
		if strings.Contains(combined, signal) {
			return false
		}
	}
	transientSignals := []string{
		"timeout", "timed out", "temporar", "try again", "connection reset", "connection refused",
		"unexpected eof", "i/o timeout", "network is unreachable", "http 429", "http 500", "http 502",
		"http 503", "http 504", "service unavailable", "did not reach", "did not produce",
		"stopped before reaching", "could not refresh", "start request",
	}
	for _, signal := range transientSignals {
		if strings.Contains(combined, signal) {
			return true
		}
	}
	return false
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
	return classifyFailure(cause.Error(), latestServerAttempt(output), state)
}

func classifyFailure(cause, output, state string) string {
	combined := strings.ToLower(cause + "\n" + latestServerAttempt(output))
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
		latestLog, latestLogErr := p.ReadFile(ctx, plan.InstanceRef, "logs/latest.log")
		if latestLogErr == nil && len(latestLog) > len(output) {
			output = string(latestLog)
			err = nil
		}
		if err != nil && latestLogErr != nil {
			return err
		}
		if len(output) > 256*1024 {
			output = output[len(output)-256*1024:]
		}
		sum := sha256.Sum256([]byte(output))
		excerpt := sanitizeConsoleOutput(output)
		summary := fmt.Sprintf("Collected %d bytes of logs (sha256:%s)", len(output), hex.EncodeToString(sum[:8]))
		if excerpt != "" {
			summary += "\nRecent log excerpt:\n" + excerpt
		}
		emit("", "logs", summary)
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
	case "console.command":
		command, requiredRisk, err := validateConsoleCommand(step)
		if err != nil {
			return err
		}
		instance, err := p.GetInstance(ctx, plan.InstanceRef)
		if err != nil {
			return err
		}
		if instance.State != "running" {
			return fmt.Errorf("console commands require a running instance; current state is %s", instance.State)
		}
		baseline, baselineErr := p.ReadOutput(ctx, plan.InstanceRef, 256)
		logBaseline, logBaselineErr := p.ReadFile(ctx, plan.InstanceRef, "logs/latest.log")
		if baselineErr != nil && logBaselineErr != nil {
			return fmt.Errorf("console output is unavailable: panel output: %v; latest log: %v", baselineErr, logBaselineErr)
		}
		if err := p.SendCommand(ctx, plan.InstanceRef, command); err != nil {
			return err
		}
		sum := sha256.Sum256([]byte(command))
		verb := strings.Fields(command)[0]
		if e.audit != nil {
			e.audit.Append("console.command.sent", plan.TaskID, verb, map[string]any{
				"command_sha256": hex.EncodeToString(sum[:]),
				"risk":           requiredRisk,
			})
		}
		if output := e.waitForConsoleOutput(
			ctx,
			p,
			plan.InstanceRef,
			strings.ToLower(strings.TrimPrefix(verb, "minecraft:")),
			baseline,
			string(logBaseline),
			baselineErr == nil,
			logBaselineErr == nil,
		); output != "" {
			emit("", "console", "控制台返回：\n"+sanitizeConsoleOutput(output))
			return nil
		}
		return fmt.Errorf("console command /%s did not produce readable output within the verification window (sha256:%s)", verb, hex.EncodeToString(sum[:8]))
	case "instance.start":
		return e.startInstance(ctx, p, plan.InstanceRef, emit)
	case "instance.stop":
		return e.stopInstance(ctx, p, plan.InstanceRef, emit)
	case "instance.restart":
		if err := p.Restart(ctx, plan.InstanceRef); err != nil {
			return err
		}
		emit("", "instance", "Restart request accepted by the panel")
		return nil
	case "plugin.resolve":
		return e.resolvePlugin(ctx, plan, step, emit)
	case "plugin.install":
		return e.installPlugin(ctx, p, plan, step, emit)
	default:
		return fmt.Errorf("tool %q is not registered", step.Tool)
	}
}

func (e *Executor) startInstance(ctx context.Context, p provider.Provider, instanceRef string, emit EventSink) error {
	instance, err := p.GetInstance(ctx, instanceRef)
	if err != nil {
		return fmt.Errorf("read instance state before start: %w", err)
	}
	if instance.State == "running" {
		emit("", "instance", "实例已在运行，无需重复启动")
		return nil
	}
	if instance.State == "starting" {
		emit("", "instance", "实例已在启动中，正在等待进入运行状态")
		return nil
	}
	if err := p.Start(ctx, instanceRef); err != nil {
		after, stateErr := p.GetInstance(ctx, instanceRef)
		if stateErr == nil && (after.State == "running" || after.State == "starting") {
			emit("", "instance", "面板启动响应异常，但实例已进入启动流程")
			return nil
		}
		return err
	}
	emit("", "instance", "启动请求已由面板接受")
	return nil
}

func (e *Executor) stopInstance(ctx context.Context, p provider.Provider, instanceRef string, emit EventSink) error {
	instance, err := p.GetInstance(ctx, instanceRef)
	if err != nil {
		return fmt.Errorf("read instance state before stop: %w", err)
	}
	if instance.State == "stopped" {
		emit("", "instance", "实例已经停止，无需重复操作")
		return nil
	}
	if err := p.Stop(ctx, instanceRef); err != nil {
		after, stateErr := p.GetInstance(ctx, instanceRef)
		if stateErr == nil && after.State == "stopped" {
			emit("", "instance", "面板停止响应异常，但实例已经停止")
			return nil
		}
		return err
	}
	emit("", "instance", "停止请求已由面板接受")
	return nil
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
	acceptEULA, _ := step.Args["accept_eula"].(bool)
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
	if !acceptEULA {
		return errors.New("Minecraft EULA acceptance is required before start; the user must explicitly agree to the Minecraft EULA")
	}
	eula := []byte("# Accepted explicitly by the server administrator through MCAI\neula=true\n")
	if err := p.WriteFile(ctx, plan.InstanceRef, "eula.txt", eula); err != nil {
		return fmt.Errorf("write Minecraft EULA acceptance: %w", err)
	}
	readBack, err := p.ReadFile(ctx, plan.InstanceRef, "eula.txt")
	if err != nil || !hasAcceptedEULA(readBack) {
		return errors.New("Minecraft EULA acceptance read-back verification failed")
	}
	emit("", "eula", "已根据管理员的明确授权写入并验证 /eula.txt：eula=true")
	if err := p.Start(ctx, plan.InstanceRef); err != nil {
		return err
	}
	emit("", "instance", "Start request accepted by the panel")
	return nil
}

func hasAcceptedEULA(contents []byte) bool {
	for _, line := range strings.Split(string(contents), "\n") {
		if strings.EqualFold(strings.TrimSpace(line), "eula=true") {
			return true
		}
	}
	return false
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
				if outputErr == nil && isServerReady(output) {
					break
				}
				if outputErr == nil && strings.Contains(strings.ToLower(latestServerAttempt(output)), "eula") {
					return errors.New("server requires Minecraft EULA acceptance before it can start")
				}
				if instanceErr == nil && instance.State == "stopped" && hasTerminalStartupFailure(output) {
					return errors.New("server stopped before reaching its ready signal")
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(2 * time.Second):
				}
			}
			_, instanceErr := p.GetInstance(ctx, plan.InstanceRef)
			output, outputErr := p.ReadOutput(ctx, plan.InstanceRef, 256)
			if instanceErr != nil || outputErr != nil || !isServerReady(output) {
				return errors.New("server did not reach the Minecraft ready signal within three minutes")
			}
		}
		if rule.Type == "plugin_enabled" {
			instance, err := p.GetInstance(ctx, plan.InstanceRef)
			if err != nil || instance.State != "running" {
				return errors.New("plugin acceptance requires a running instance")
			}
			baseline, baselineErr := p.ReadOutput(ctx, plan.InstanceRef, 256)
			logBaseline, logBaselineErr := p.ReadFile(ctx, plan.InstanceRef, "logs/latest.log")
			if baselineErr != nil && logBaselineErr != nil {
				return errors.New("plugin acceptance cannot read console output or latest.log")
			}
			if err := p.SendCommand(ctx, plan.InstanceRef, "plugins"); err != nil {
				return fmt.Errorf("query loaded plugins: %w", err)
			}
			result := e.waitForConsoleOutput(
				ctx, p, plan.InstanceRef, "plugins", baseline, string(logBaseline),
				baselineErr == nil, logBaselineErr == nil,
			)
			latestLog, _ := p.ReadFile(ctx, plan.InstanceRef, "logs/latest.log")
			if !containsPluginEvidence(result+"\n"+string(latestLog), rule.Name) {
				return fmt.Errorf("plugin %s was not present in console or startup-log evidence", rule.Name)
			}
		}
	}
	return nil
}

func planHasTool(plan protocol.TaskPlan, tool string) bool {
	for _, step := range plan.Steps {
		if step.Tool == tool {
			return true
		}
	}
	return false
}

func containsPluginEvidence(output, project string) bool {
	lower := strings.ToLower(output)
	names := []string{strings.ToLower(strings.TrimSpace(project))}
	if names[0] == "essentialsx" {
		names = append(names, "essentials")
	}
	for _, name := range names {
		if name == "" {
			continue
		}
		if strings.Contains(lower, "enabling "+name) || strings.Contains(lower, "plugins (") && strings.Contains(lower, name) || strings.Contains(lower, "server plugins") && strings.Contains(lower, name) {
			return true
		}
	}
	return false
}

func isServerReady(output string) bool {
	lower := strings.ToLower(latestServerAttempt(output))
	return strings.Contains(lower, "done (") || strings.Contains(lower, "for help, type \"help\"")
}

// latestServerAttempt prevents a prior launch's errors or ready signal from
// being interpreted as evidence for the launch currently being verified.
func latestServerAttempt(output string) string {
	lower := strings.ToLower(output)
	markers := []string{
		"> /usr/bin/java",
		"[bootstrap] running java",
		"starting org.bukkit.craftbukkit.main",
		"starting minecraft server version",
	}
	start := -1
	for _, marker := range markers {
		if index := strings.LastIndex(lower, marker); index > start {
			start = index
		}
	}
	if start < 0 {
		return output
	}
	return output[start:]
}

func hasTerminalStartupFailure(output string) bool {
	lower := strings.ToLower(latestServerAttempt(output))
	for _, signal := range []string{
		"invalid or corrupt jar", "unable to access jarfile", "address already in use",
		"failed to bind", "unsupportedclassversion", "outofmemory", "permission denied",
		"could not create the java virtual machine", "exception in server tick loop", "crash report",
	} {
		if strings.Contains(lower, signal) {
			return true
		}
	}
	return false
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

func validateConsoleCommand(step protocol.TaskStep) (string, string, error) {
	command := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(stringArg(step.Args, "command")), "/"))
	if command == "" {
		return "", "", errors.New("console command must not be empty")
	}
	if len([]byte(command)) > 256 {
		return "", "", errors.New("console command exceeds the 256-byte limit")
	}
	if strings.ContainsAny(command, "\r\n") || strings.IndexFunc(command, unicode.IsControl) >= 0 {
		return "", "", errors.New("console command must be a single printable line")
	}
	fields := strings.Fields(command)
	verb := strings.ToLower(strings.TrimPrefix(fields[0], "minecraft:"))
	if verb == "stop" || verb == "restart" || verb == "quit" || verb == "end" {
		return "", "", errors.New("server lifecycle commands must use the dedicated instance tool")
	}
	requiredRisk := consoleCommandRisk(verb)
	if consoleRiskRank(step.Risk) < consoleRiskRank(requiredRisk) {
		return "", "", fmt.Errorf("console command /%s requires %s risk, got %s", verb, requiredRisk, step.Risk)
	}
	if consoleRiskRank(requiredRisk) >= consoleRiskRank("medium") && !step.RequiresConfirmation {
		return "", "", fmt.Errorf("console command /%s requires explicit confirmation", verb)
	}
	return command, requiredRisk, nil
}

func consoleCommandRisk(verb string) string {
	switch verb {
	case "list", "help", "version", "plugins", "pl", "tps", "mspt", "seed":
		return "read"
	case "say", "me":
		return "low"
	case "time", "weather", "difficulty", "gamerule", "gamemode", "give", "clear", "tp", "teleport", "effect", "enchant", "xp", "experience", "setworldspawn", "spawnpoint":
		return "medium"
	default:
		return "high"
	}
}

func consoleRiskRank(risk string) int {
	switch risk {
	case "read":
		return 0
	case "low":
		return 1
	case "medium":
		return 2
	case "high":
		return 3
	default:
		return -1
	}
}

func (e *Executor) waitForConsoleOutput(
	ctx context.Context,
	p provider.Provider,
	instanceRef, verb, outputBaseline, logBaseline string,
	usePanelOutput, useLatestLog bool,
) string {
	const attempts = 24
	for attempt := 0; attempt < attempts; attempt++ {
		if usePanelOutput {
			output, err := p.ReadOutput(ctx, instanceRef, 256)
			if err == nil {
				if delta := consoleOutputDelta(outputBaseline, output); delta != "" {
					if consoleEvidenceComplete(verb, delta) {
						return delta
					}
				}
			}
		}
		if useLatestLog {
			output, err := p.ReadFile(ctx, instanceRef, "logs/latest.log")
			if err == nil {
				if delta := consoleOutputDelta(logBaseline, string(output)); delta != "" {
					if consoleEvidenceComplete(verb, delta) {
						return delta
					}
				}
			}
		}
		if attempt == attempts-1 {
			break
		}
		timer := time.NewTimer(e.consolePollDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ""
		case <-timer.C:
		}
	}
	return ""
}

func consoleEvidenceComplete(verb, output string) bool {
	lower := strings.ToLower(output)
	switch verb {
	case "list":
		return strings.Contains(lower, "there are") && strings.Contains(lower, "players online")
	case "tps":
		return strings.Contains(lower, "tps") && !strings.Contains(lower, "please wait")
	case "version":
		return strings.Contains(lower, "this server is running") ||
			strings.Contains(lower, "server version") ||
			strings.Contains(lower, "paper version") ||
			strings.Contains(lower, "minecraft version")
	case "plugins", "pl":
		return strings.Contains(lower, "server plugins") || strings.Contains(lower, "plugins (")
	case "mspt":
		return strings.Contains(lower, "mspt")
	default:
		return strings.TrimSpace(output) != ""
	}
}

func consoleOutputDelta(before, after string) string {
	before = strings.ReplaceAll(before, "\r\n", "\n")
	after = strings.ReplaceAll(after, "\r\n", "\n")
	if after == "" || after == before {
		return ""
	}
	if strings.HasPrefix(after, before) {
		return strings.TrimSpace(after[len(before):])
	}
	before = strings.TrimSpace(before)
	if before != "" {
		lastLine := before
		if index := strings.LastIndex(before, "\n"); index >= 0 {
			lastLine = before[index+1:]
		}
		if index := strings.LastIndex(after, lastLine); index >= 0 {
			return strings.TrimSpace(after[index+len(lastLine):])
		}
	}
	return strings.TrimSpace(after)
}

var consoleANSI = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

func sanitizeConsoleOutput(output string) string {
	output = consoleANSI.ReplaceAllString(output, "")
	output = sensitiveDiagnostic.ReplaceAllString(output, "$1=[REDACTED]")
	output = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, output)
	output = strings.TrimSpace(output)
	if len(output) > 8*1024 {
		output = output[len(output)-8*1024:]
	}
	return output
}
