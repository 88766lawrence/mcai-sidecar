package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"

	"github.com/mcai/sidecar-agent/internal/audit"
	"github.com/mcai/sidecar-agent/internal/logquery"
	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
	"github.com/mcai/sidecar-agent/internal/security"
)

// Structured observations are optional producer-owned facts. Summary remains
// display/audit text and is never parsed into business evidence.
type EventSink func(state, kind, summary string, observed ...map[string]any)

type Executor struct {
	providers        map[string]provider.Provider
	dataDir          string
	audit            *audit.Writer
	releaseResolver  releaseResolver
	pluginResolver   pluginResolver
	webSearcher      webSearcher
	fileDownloader   fileDownloadFetcher
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
		webSearcher:      newWebSearcherFromEnv(),
		fileDownloader:   newSecureFileDownloadFetcher(),
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
		stepEmit := emit
		if step.Purpose == "verify" {
			stepEmit = verificationEventSink(emit)
		}
		if err := e.executeStepWithRecovery(ctx, p, plan, step, stepEmit); err != nil {
			e.audit.Append("tool.execution.failed", plan.TaskID, err.Error(), map[string]any{"tool": step.Tool})
			if planHasTool(plan, "plugin.install") {
				e.rollbackPlugin(ctx, p, plan, emit)
			}
			emit("FAILED", "tool", fmt.Sprintf("%s failed: %v", step.Tool, err))
			return
		}
	}
	hasIndependentVerification := len(plan.Acceptance) > 0
	for _, step := range plan.Steps {
		if step.Purpose == "verify" {
			hasIndependentVerification = true
			break
		}
	}
	if hasIndependentVerification {
		emit("VERIFYING", "state", "All steps committed; checking acceptance signals")
	}
	for attempt := 1; ; attempt++ {
		if err := e.verify(ctx, p, plan); err != nil {
			lastStep, canRecover := finalAutonomousStep(plan.Steps)
			diagnosis := e.diagnoseFailure(ctx, p, plan.InstanceRef, verificationFailureTool(plan), err)
			emit("", "diagnosis", diagnosis)
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
	if hasIndependentVerification {
		e.audit.Append("tool.execution.verified", plan.TaskID, "All deterministic acceptance checks passed", nil)
		emit("SUCCEEDED", "verification", "All deterministic acceptance checks passed")
	} else {
		e.audit.Append("tool.execution.completed", plan.TaskID, "Execution callback succeeded without an independent readback", nil)
		emit("SUCCEEDED", "execution", "Executed successfully; not independently verified")
	}
}

func verificationEventSink(emit EventSink) EventSink {
	return func(state, kind, summary string, observed ...map[string]any) {
		if state == "" && kind != "" && kind != "state" && kind != "diagnosis" && kind != "recovery" {
			kind = "verification." + kind
		}
		emit(state, kind, summary, observed...)
	}
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
		diagnosis := e.diagnoseFailure(ctx, p, plan.InstanceRef, step.Tool, err)
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
	if step.Tool == "file.download" {
		return false
	}
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

func (e *Executor) diagnoseFailure(ctx context.Context, p provider.Provider, instanceRef, tool string, cause error) string {
	state := "unknown"
	if instance, err := p.GetInstance(ctx, instanceRef); err == nil {
		state = instance.State
	}
	output := ""
	if failureUsesServerOutput(tool) {
		if collected, err := p.ReadOutput(ctx, instanceRef, 160); err == nil {
			if len(collected) > 64*1024 {
				collected = collected[len(collected)-64*1024:]
			}
			output = collected
		}
	}
	return classifyFailure(cause.Error(), latestServerAttempt(output), state)
}

func failureUsesServerOutput(tool string) bool {
	switch tool {
	case "instance.start", "instance.restart", "server.install":
		return true
	default:
		return false
	}
}

func verificationFailureTool(plan protocol.TaskPlan) string {
	startupTool := ""
	for _, step := range plan.Steps {
		if failureUsesServerOutput(step.Tool) {
			startupTool = step.Tool
		}
	}
	if startupTool == "" {
		return ""
	}
	for _, rule := range plan.Acceptance {
		if rule.Type == "server_ready" || rule.Type == "instance_state" && rule.Expected == "running" {
			return startupTool
		}
	}
	return ""
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
		windowMinutes, maxLines, filters, query, err := validatedLogQueryArgs(step.Args)
		if err != nil {
			return err
		}
		output, err := p.ReadOutput(ctx, plan.InstanceRef, 256)
		latestLog, latestLogErr := p.ReadFile(ctx, plan.InstanceRef, "logs/latest.log")
		// The panel output can retain an older run. latest.log is the
		// current log source even when it is shorter than that output.
		if latestLogErr == nil {
			output = string(latestLog)
			err = nil
		}
		if err != nil && latestLogErr != nil {
			return err
		}
		if len(output) > 256*1024 {
			output = output[len(output)-256*1024:]
		}
		recent := recentLogWindow(output, windowMinutes, maxLines)
		matches := filterLogLines(recent, query)
		samples := matches
		if len(samples) > 5 {
			samples = samples[len(samples)-5:]
		}
		sanitizedSamples := make([]string, 0, len(samples))
		for _, line := range samples {
			if sanitized := sanitizeConsoleOutput(line); sanitized != "" {
				sanitizedSamples = append(sanitizedSamples, sanitized)
			}
		}
		filterLabel := strings.Join(filters, "|")
		if filterLabel == "" {
			filterLabel = "all"
		}
		summary := fmt.Sprintf("Log query result: matches=%d; window_minutes=%d; scanned_lines=%d; sample_count=%d; query_digest=%s; filters=%s", len(matches), windowMinutes, len(recent), len(sanitizedSamples), query.Digest, filterLabel)
		summary += "\nTime window is relative to the latest timestamp in the available log; absolute wall-clock recency is unverified."
		if len(sanitizedSamples) == 0 {
			summary += "\nMatched samples: <none>"
		} else {
			summary += "\nMatched samples:\n" + strings.Join(sanitizedSamples, "\n")
		}
		emit("", "logs", summary, map[string]any{
			"schema_version": "logs-query-result/v1",
			"matches":        len(matches), "window_minutes": windowMinutes,
			"scanned_lines": len(recent), "samples": sanitizedSamples,
			"query_digest": query.Digest,
		})
		return nil
	case "files.list":
		target := stringArg(step.Args, "path")
		if target == "" {
			target = "/"
		}
		structured, ok := p.(provider.StructuredFileLister)
		if !ok {
			return errors.New("provider does not expose structured file listings")
		}
		listing, err := structured.ListFileEntries(ctx, plan.InstanceRef, target)
		if err != nil {
			return err
		}
		observed, err := filesListObservation(listing, target, stringArg(step.Args, "suffix"))
		if err != nil {
			return err
		}
		names := make([]string, 0, len(listing.Names))
		for _, name := range listing.Names {
			if suffix := stringArg(step.Args, "suffix"); suffix == "" || strings.HasSuffix(strings.ToLower(name), strings.ToLower(suffix)) {
				names = append(names, name)
			}
		}
		emit("", "files", fmt.Sprintf("实例目录 %s：共 %d 项；匹配 %d 项：%s", target, listing.Total, len(names), strings.Join(names, "、")), observed)
		return nil
	case "instance.metrics":
		if stringArg(step.Args, "schema_version") != "instance-metrics/v2" {
			return errors.New("instance.metrics requires instance-metrics/v2")
		}
		metrics := stringListArg(step.Args, "metrics")
		if len(metrics) == 0 || len(metrics) > 3 {
			return errors.New("instance.metrics requires one to three registered metrics")
		}
		seen := map[string]bool{}
		for _, metric := range metrics {
			if metric != "uptime" && metric != "cpu" && metric != "memory" || seen[metric] {
				return errors.New("instance.metrics contains an unregistered or duplicate metric")
			}
			seen[metric] = true
		}
		instance, err := p.GetInstance(ctx, plan.InstanceRef)
		if err != nil {
			return err
		}
		if instance.State != "running" {
			return fmt.Errorf("instance metrics require a running instance; current state is %s", instance.State)
		}
		if seen["memory"] && instance.MemoryBytes <= 0 {
			return errors.New("provider did not return a positive instance memory measurement")
		}
		if seen["cpu"] && (instance.CPUUsage < 0 || instance.CPUUsage > 100) {
			return errors.New("provider returned an invalid instance CPU measurement")
		}
		if seen["uptime"] && instance.UptimeSeconds < 0 {
			return errors.New("provider returned an invalid instance uptime")
		}
		includeCapacity, _ := step.Args["include_capacity"].(bool)
		if includeCapacity && instance.MemoryLimitBytes <= 0 {
			return errors.New("provider did not return an authoritative instance memory capacity")
		}
		if seen["memory"] && instance.MemoryLimitBytes > 0 && instance.MemoryBytes > instance.MemoryLimitBytes {
			return errors.New("instance memory measurement exceeds its authoritative capacity")
		}
		emit("", "metrics", fmt.Sprintf("Instance metrics v2: uptime_seconds=%d; cpu_percent=%.2f; memory_bytes=%d; memory_limit_bytes=%d; pressure_policy=resource-pressure/v1", instance.UptimeSeconds, instance.CPUUsage, instance.MemoryBytes, instance.MemoryLimitBytes))
		return nil
	case "players.inspect":
		if stringArg(step.Args, "schema_version") != "players-inspect/v1" || stringArg(step.Args, "selector") != "first-online" {
			return errors.New("players.inspect requires the registered first-online selector")
		}
		fields := stringListArg(step.Args, "fields")
		if len(fields) != 1 || fields[0] != "gamemode" {
			return errors.New("players.inspect supports only the gamemode field")
		}
		listOutput, err := e.executeConsoleRead(ctx, p, plan.InstanceRef, "list")
		if err != nil {
			return err
		}
		count, names, err := parseOnlinePlayerList(listOutput)
		if err != nil {
			return err
		}
		if count == 0 {
			emit("", "players", "Player inspection v1: online_count=0; selected=<none>; gamemode=<none>; condition=no-online-players")
			return nil
		}
		selected := names[0]
		modeOutput, err := e.executeConsoleRead(ctx, p, plan.InstanceRef, "data get entity "+selected+" playerGameType")
		if err != nil {
			return err
		}
		mode, err := parsePlayerGamemode(selected, modeOutput)
		if err != nil {
			return err
		}
		emit("", "players", fmt.Sprintf("Player inspection v1: online_count=%d; selected=%s; gamemode=%s; condition=player-inspected", count, selected, mode))
		return nil
	case "server.install":
		return e.installServer(ctx, p, plan, step, emit)
	case "file.download":
		return e.downloadFile(ctx, p, plan, step, emit)
	case "config.patch":
		return e.configPatch(ctx, p, plan, step, emit)
	case "config.inspect":
		target, err := security.NormalizeRelative(stringArg(step.Args, "path"))
		if err != nil {
			return err
		}
		contents, err := p.ReadFile(ctx, plan.InstanceRef, target)
		if err != nil {
			return err
		}
		if len(contents) > 2<<20 {
			return errors.New("configuration file exceeds the 2 MiB limit")
		}
		keys := stringListArg(step.Args, "keys")
		observed, err := configInspectObservation(contents, target, keys)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(contents)
		excerpt := sanitizeConfiguration([]byte(selectConfigurationKeys(contents, target, keys)))
		emit("", "config", fmt.Sprintf("Read %s (%d bytes, sha256:%s)\n%s", target, len(contents), hex.EncodeToString(digest[:8]), excerpt), observed)
		return nil
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
		if strings.EqualFold(strings.TrimPrefix(verb, "minecraft:"), "plugins") {
			return e.readLoadedPlugins(ctx, p, plan.TaskID, plan.InstanceRef, command, baseline, string(logBaseline), baselineErr == nil, logBaselineErr == nil, emit)
		}
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
			command,
			baseline,
			string(logBaseline),
			baselineErr == nil,
			logBaselineErr == nil,
			requiredRisk != "read",
		); output != "" {
			summary := "控制台返回：\n" + sanitizeConsoleOutput(output)
			fields := strings.Fields(command)
			if len(fields) == 2 && strings.EqualFold(strings.TrimPrefix(fields[0], "minecraft:"), "gamerule") {
				value, parseErr := parseGameruleReadResult(fields[1], output)
				if parseErr != nil {
					return parseErr
				}
				summary += fmt.Sprintf("\nGamerule read result: rule=%s; value=%s", fields[1], value)
			}
			outcome := ClassifyConsoleCommandOutcomeForCommand(command, summary, requiredRisk != "read")
			emit("", "console", summary)
			if outcome.Status == "rejected" || outcome.Status == "indeterminate" {
				return errors.New(outcome.UserMessage)
			}
			return nil
		}
		emit("", "console", "服务器已接收命令，但没有返回可用于判断结果的消息。")
		return errors.New("服务器没有返回可判断的命令结果，因此无法确认这次操作是否生效")
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
		return e.resolvePlugin(ctx, p, plan, step, emit)
	case "web.search":
		return e.executeWebSearch(ctx, step, emit)
	case "plugin.install":
		return e.installPlugin(ctx, p, plan, step, emit)
	default:
		return fmt.Errorf("tool %q is not registered", step.Tool)
	}
}

func (e *Executor) readLoadedPlugins(ctx context.Context, p provider.Provider, taskID, instanceRef, command, baseline, logBaseline string, panelOK, logOK bool, emit EventSink) error {
	output := e.waitForConsoleOutput(ctx, p, instanceRef, command, baseline, logBaseline, panelOK, logOK, false)
	if output == "" {
		// Some Paper/MCSManager combinations expose command replies only after
		// the bounded console poll has completed. A final read is still scoped
		// to the baseline captured immediately before this dispatch; it never
		// searches historical output for an older plugins response.
		if panelOK {
			if latest, err := p.ReadOutput(ctx, instanceRef, 256); err == nil {
				if delta := consoleOutputDelta(baseline, latest); delta != "" {
					output = delta
				}
			}
		}
		if output == "" && logOK {
			if latest, err := p.ReadFile(ctx, instanceRef, "logs/latest.log"); err == nil {
				if delta := consoleOutputDelta(logBaseline, string(latest)); delta != "" {
					output = delta
				}
			}
		}
	}
	if output == "" {
		if e.audit != nil {
			e.audit.Append("console.callback.incomplete", taskID, "loaded-plugin inventory not observed after dispatch", map[string]any{"command": "plugins"})
		}
		return errors.New("the server did not return a complete loaded-plugin inventory")
	}
	result := sanitizeConsoleOutput(consoleResultOutput("plugins", output))
	declared, items, ok := loadedPluginInventory(result)
	if !ok {
		if e.audit != nil {
			e.audit.Append("console.callback.unparsed", taskID, "loaded-plugin callback did not match the typed inventory contract", map[string]any{"sanitized_callback": result})
		}
		return errors.New("the loaded-plugin callback was incomplete")
	}
	emit("", "console", fmt.Sprintf("Server Plugins (%d): %s", declared, strings.Join(items, ", ")))
	return nil
}

func loadedPluginInventory(output string) (int, []string, bool) {
	output = sanitizeConsoleOutput(output)
	header := regexp.MustCompile(`(?i)(?:server\s+)?plugins?\s*\((\d+)\)\s*:`).FindStringSubmatchIndex(output)
	if len(header) != 4 {
		return 0, nil, false
	}
	declared, err := strconv.Atoi(output[header[2]:header[3]])
	if err != nil || declared < 0 {
		return 0, nil, false
	}
	if declared == 0 {
		return 0, []string{}, true
	}
	items := []string{}
	prefix := regexp.MustCompile(`^\s*(?:\[[^\]\r\n]+\]\s*)+:\s*`)
	for _, line := range strings.Split(output[header[1]:], "\n") {
		hadLogPrefix := prefix.MatchString(line)
		line = prefix.ReplaceAllString(line, "")
		if hadLogPrefix && !regexp.MustCompile(`(?i)^\s*(?:(?:(?:bukkit|paper)\s+)?plugins?\s*:|[-*]\s*)`).MatchString(line) {
			continue
		}
		line = regexp.MustCompile(`(?i)^\s*(?:(?:bukkit|paper)\s+)?plugins?\s*:\s*`).ReplaceAllString(line, "")
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "-"))
		for _, item := range strings.Split(line, ",") {
			if name := strings.Trim(strings.TrimSpace(item), "[]"); name != "" && regexp.MustCompile(`^[A-Za-z0-9_.+-]+$`).MatchString(name) {
				items = append(items, name)
			}
		}
		if len(items) >= declared {
			break
		}
	}
	return declared, items, len(items) == declared
}

func (e *Executor) executeConsoleRead(ctx context.Context, p provider.Provider, instanceRef, command string) (string, error) {
	instance, err := p.GetInstance(ctx, instanceRef)
	if err != nil {
		return "", err
	}
	if instance.State != "running" {
		return "", fmt.Errorf("console reads require a running instance; current state is %s", instance.State)
	}
	baseline, baselineErr := p.ReadOutput(ctx, instanceRef, 256)
	logBaseline, logBaselineErr := p.ReadFile(ctx, instanceRef, "logs/latest.log")
	if baselineErr != nil && logBaselineErr != nil {
		return "", fmt.Errorf("console output is unavailable: panel output: %v; latest log: %v", baselineErr, logBaselineErr)
	}
	if err := p.SendCommand(ctx, instanceRef, command); err != nil {
		return "", err
	}
	output := e.waitForConsoleOutput(ctx, p, instanceRef, command, baseline, string(logBaseline), baselineErr == nil, logBaselineErr == nil, false)
	if output == "" {
		return "", fmt.Errorf("console read %q did not produce complete output", strings.Fields(command)[0])
	}
	return sanitizeConsoleOutput(output), nil
}

func parseOnlinePlayerList(output string) (int, []string, error) {
	match := regexp.MustCompile(`(?i)There\s+(?:are|is)\s+(\d+)\s+of\s+a\s+max\s+of\s+\d+\s+players?\s+online(?:\s*:\s*([^\r\n]*))?`).FindStringSubmatch(output)
	if len(match) == 0 {
		return 0, nil, errors.New("player list callback did not contain a complete online roster")
	}
	count, err := strconv.Atoi(match[1])
	if err != nil || count < 0 {
		return 0, nil, errors.New("player list callback contained an invalid count")
	}
	names := make([]string, 0)
	for _, candidate := range strings.Split(match[2], ",") {
		name := strings.TrimSpace(candidate)
		if name == "" {
			continue
		}
		if ok, _ := regexp.MatchString(`^[A-Za-z0-9_]{3,16}$`, name); !ok {
			return 0, nil, errors.New("player list callback contained an invalid player name")
		}
		names = append(names, name)
	}
	if len(names) != count {
		return 0, nil, errors.New("player list callback count and roster disagree")
	}
	return count, names, nil
}

func parsePlayerGamemode(player, output string) (string, error) {
	pattern := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(player) + `\s+has\s+the\s+following\s+entity\s+data:\s*([0-3])\b`)
	match := pattern.FindStringSubmatch(output)
	if len(match) == 0 {
		return "", errors.New("player gamemode callback did not match the selected player")
	}
	modes := map[string]string{"0": "survival", "1": "creative", "2": "adventure", "3": "spectator"}
	return modes[match[1]], nil
}

func sanitizeConfiguration(contents []byte) string {
	lines := strings.Split(string(contents), "\n")
	for index, line := range lines {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "password") || strings.Contains(lower, "passwd") || strings.Contains(lower, "api_key") ||
			strings.Contains(lower, "api-key") || strings.Contains(lower, "secret") || strings.Contains(lower, "token") {
			separator := strings.IndexAny(line, "=:")
			if separator >= 0 {
				lines[index] = line[:separator+1] + " [REDACTED]"
			} else {
				lines[index] = "[REDACTED SENSITIVE CONFIGURATION LINE]"
			}
		}
	}
	value := strings.Join(lines, "\n")
	if len(value) > 32*1024 {
		value = value[:32*1024] + "\n…"
	}
	return value
}

func selectConfigurationKeys(contents []byte, path string, keys []string) string {
	values := map[string]string{}
	if strings.HasSuffix(strings.ToLower(path), ".properties") || strings.HasSuffix(strings.ToLower(path), ".conf") {
		for _, line := range strings.Split(string(contents), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
				continue
			}
			separator := strings.IndexAny(trimmed, "=:")
			if separator <= 0 {
				continue
			}
			values[strings.TrimSpace(trimmed[:separator])] = strings.TrimSpace(trimmed[separator+1:])
		}
	} else {
		var document any
		if err := yaml.Unmarshal(contents, &document); err == nil {
			for _, key := range keys {
				if value, ok := nestedConfigurationValue(document, strings.Split(key, ".")); ok {
					encoded, err := json.Marshal(value)
					if err == nil {
						values[key] = strings.Trim(string(encoded), "\"")
					}
				}
			}
		}
	}
	lines := make([]string, 0, len(keys))
	for _, key := range keys {
		value, ok := values[key]
		if !ok {
			for candidate, candidateValue := range values {
				if strings.EqualFold(candidate, key) {
					value, ok = candidateValue, true
					break
				}
			}
		}
		if !ok {
			value = "<MISSING>"
		}
		lines = append(lines, key+"="+value)
	}
	return strings.Join(lines, "\n")
}

func nestedConfigurationValue(value any, path []string) (any, bool) {
	current := value
	for _, part := range path {
		mapping, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		var next any
		found := false
		for key, candidate := range mapping {
			if strings.EqualFold(key, part) {
				next, found = candidate, true
				break
			}
		}
		if !found {
			return nil, false
		}
		current = next
	}
	return current, true
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
	if !ok || len(patches) == 0 || len(patches) > 20 {
		return errors.New("between one and twenty structured configuration patches are required")
	}
	after := append([]byte(nil), before...)
	for _, item := range patches {
		patch, ok := item.(map[string]any)
		if !ok || (stringArg(patch, "op") != "replace" && stringArg(patch, "op") != "add") {
			return errors.New("unsupported patch operation")
		}
		after, err = patchConfiguration(after, target, stringArg(patch, "key"), patch["value"])
		if err != nil {
			return err
		}
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
				baselineErr == nil, logBaselineErr == nil, false,
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

func validatedLogQueryArgs(args map[string]any) (int, int, []string, logquery.Query, error) {
	windowMinutes, ok := numericArg(args, "window_minutes")
	if !ok {
		windowMinutes = 60
	}
	maxLines, ok := numericArg(args, "max_lines")
	if !ok {
		maxLines = 500
	}
	filters := stringListArg(args, "filters")
	if windowMinutes < 1 || windowMinutes > 1440 {
		return 0, 0, nil, logquery.Query{}, errors.New("logs.query window_minutes must be between 1 and 1440")
	}
	if maxLines < 20 || maxLines > 1000 {
		return 0, 0, nil, logquery.Query{}, errors.New("logs.query max_lines must be between 20 and 1000")
	}
	for _, filter := range filters {
		if len([]rune(filter)) > 64 || strings.TrimSpace(filter) == "" || strings.IndexFunc(filter, unicode.IsControl) >= 0 {
			return 0, 0, nil, logquery.Query{}, errors.New("logs.query filter must be a short printable value")
		}
	}
	query, normalizedFilters, err := logquery.Parse(args, false)
	if err != nil {
		return 0, 0, nil, logquery.Query{}, err
	}
	return windowMinutes, maxLines, normalizedFilters, query, nil
}

func numericArg(args map[string]any, key string) (int, bool) {
	switch value := args[key].(type) {
	case int:
		return value, true
	case float64:
		if value == float64(int(value)) {
			return int(value), true
		}
	case json.Number:
		parsed, err := strconv.Atoi(value.String())
		return parsed, err == nil
	}
	return 0, false
}

var logClockPattern = regexp.MustCompile(`\[(\d{2}):(\d{2}):(\d{2})\]`)

func recentLogWindow(output string, windowMinutes, maxLines int) []string {
	lines := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	latest := -1
	seconds := make([]int, len(lines))
	for index, line := range lines {
		seconds[index] = -1
		match := logClockPattern.FindStringSubmatch(line)
		if len(match) != 4 {
			continue
		}
		hour, _ := strconv.Atoi(match[1])
		minute, _ := strconv.Atoi(match[2])
		second, _ := strconv.Atoi(match[3])
		seconds[index] = hour*3600 + minute*60 + second
		latest = seconds[index]
	}
	selected := make([]string, 0, len(lines))
	includeContinuation := latest < 0
	for index, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if latest >= 0 && seconds[index] >= 0 {
			age := latest - seconds[index]
			if age < 0 {
				age += 24 * 3600
			}
			includeContinuation = age <= windowMinutes*60
		}
		if includeContinuation {
			selected = append(selected, line)
		}
	}
	if len(selected) > maxLines {
		selected = selected[len(selected)-maxLines:]
	}
	return selected
}

var logFilterTerms = map[string][]string{
	"authentication_failure": {"authentication failed", "login failed", "failed to authenticate", "认证失败", "鉴权失败", "登录失败"},
	"connection_failure":     {"connection failed", "failed to connect", "connection refused", "handshake failed", "连接失败", "拒绝连接", "握手失败"},
	"timeout":                {"timeout", "timed out", "超时"},
	"resource_failure":       {"resource pack failed", "download failed", "资源包下载失败", "下载失败"},
	"permission_failure":     {"permission denied", "access denied", "权限拒绝", "权限不足"},
	"disconnect":             {"disconnected", "disconnect", "connection closed", "断开连接", "掉线"},
	"warning":                {"warn", "warning", "警告"},
	"crash":                  {"crash", "fatal", "崩溃", "崩服"},
	"error":                  {"error", "exception", "错误", "报错"},
}

func legacyFilterLogLines(lines, filters []string) []string {
	if len(filters) == 0 {
		return append([]string(nil), lines...)
	}
	result := make([]string, 0)
	for _, line := range lines {
		lower := strings.ToLower(line)
		matched := false
		for _, filter := range filters {
			terms := logFilterTerms[filter]
			if strings.HasPrefix(filter, "literal:") {
				terms = []string{strings.TrimPrefix(filter, "literal:")}
			} else if len(terms) == 0 {
				terms = []string{filter}
			}
			for _, term := range terms {
				if strings.Contains(lower, strings.ToLower(term)) {
					matched = true
					break
				}
			}
			if matched {
				break
			}
		}
		if matched {
			result = append(result, line)
		}
	}
	return result
}

func filterLogLines(lines []string, query logquery.Query) []string {
	result := make([]string, 0)
	for _, line := range lines {
		if logquery.Match(line, query) {
			result = append(result, line)
		}
	}
	return result
}

func stringListArg(args map[string]any, key string) []string {
	value, ok := args[key]
	if !ok {
		return nil
	}
	if stringsValue, ok := value.([]string); ok {
		return stringsValue
	}
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			result = append(result, text)
		}
	}
	return result
}

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
	requiredRisk := consoleCommandRisk(command)
	if consoleRiskRank(step.Risk) < consoleRiskRank(requiredRisk) {
		return "", "", fmt.Errorf("console command /%s requires %s risk, got %s", verb, requiredRisk, step.Risk)
	}
	if consoleRiskRank(requiredRisk) >= consoleRiskRank("medium") && !step.RequiresConfirmation {
		return "", "", fmt.Errorf("console command /%s requires explicit confirmation", verb)
	}
	return command, requiredRisk, nil
}

func consoleCommandRisk(command string) string {
	fields := strings.Fields(strings.ToLower(strings.TrimSpace(command)))
	if len(fields) == 0 {
		return "high"
	}
	verb := strings.TrimPrefix(fields[0], "minecraft:")
	if matched, _ := regexp.MatchString(`(?i)^data\s+get\s+entity\s+[a-z0-9_]{3,16}\s+playerGameType$`, strings.TrimSpace(command)); matched {
		return "read"
	}
	if verb == "difficulty" && len(fields) == 1 {
		return "read"
	}
	if verb == "whitelist" && len(fields) == 2 && fields[1] == "list" {
		return "read"
	}
	if verb == "time" && len(fields) == 3 && fields[1] == "query" && (fields[2] == "daytime" || fields[2] == "gametime" || fields[2] == "day") {
		return "read"
	}
	if verb == "worldborder" && len(fields) == 2 && fields[1] == "get" {
		return "read"
	}
	if verb == "datapack" && len(fields) == 3 && fields[1] == "list" && fields[2] == "enabled" {
		return "read"
	}
	if verb == "datapack" && len(fields) == 3 && fields[1] == "list" && fields[2] == "available" {
		return "read"
	}
	if verb == "banlist" && len(fields) == 2 && fields[1] == "players" {
		return "read"
	}
	if verb == "team" && len(fields) == 2 && fields[1] == "list" {
		return "read"
	}
	if verb == "scoreboard" && len(fields) == 3 && fields[1] == "objectives" && fields[2] == "list" {
		return "read"
	}
	if verb == "forceload" && len(fields) == 2 && fields[1] == "query" {
		return "read"
	}
	if verb == "gamerule" && len(fields) == 2 {
		return "read"
	}
	if matched, _ := regexp.MatchString(`(?i)^playsound\s+minecraft:block\.note_block\.bell\s+master\s+@a\s+~\s+~\s+~\s+1\s+1$`, strings.TrimSpace(command)); matched {
		return "medium"
	}
	if matched, _ := regexp.MatchString(`(?i)^execute\s+if\s+entity\s+@a\s+run\s+execute\s+as\s+@a\s+at\s+@s\s+run\s+particle\s+minecraft:happy_villager\s+~\s+~1\s+~\s+0\.25\s+0\.25\s+0\.25\s+0\s+5\s+force\s+@s$`, strings.TrimSpace(command)); matched {
		return "medium"
	}
	switch verb {
	case "list", "help", "version", "plugins", "pl", "tps", "mspt", "seed":
		return "read"
	case "say", "me":
		return "low"
	case "title", "time", "weather", "difficulty", "gamerule", "gamemode", "whitelist", "give", "clear", "tp", "teleport", "effect", "enchant", "xp", "experience", "setworldspawn", "spawnpoint":
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
	requireExplicit bool,
) string {
	const attempts = 24
	for attempt := 0; attempt < attempts; attempt++ {
		if usePanelOutput {
			output, err := p.ReadOutput(ctx, instanceRef, 256)
			if err == nil {
				if delta := consoleOutputDelta(outputBaseline, output); delta != "" {
					if consoleEvidenceComplete(verb, delta, requireExplicit) {
						return delta
					}
				}
			}
		}
		if useLatestLog {
			output, err := p.ReadFile(ctx, instanceRef, "logs/latest.log")
			if err == nil {
				if delta := consoleOutputDelta(logBaseline, string(output)); delta != "" {
					if consoleEvidenceComplete(verb, delta, requireExplicit) {
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

func consoleEvidenceComplete(command, output string, strict ...bool) bool {
	output = sanitizeConsoleOutput(output)
	normalizedCommand := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(command), "/")))
	fields := strings.Fields(strings.TrimPrefix(normalizedCommand, "minecraft:"))
	if len(fields) == 0 {
		return false
	}
	verb := fields[0]
	result := consoleResultOutput(verb, output)
	if result == "" {
		return false
	}
	lower := strings.ToLower(result)
	requireExplicit := len(strict) > 0 && strict[0]
	switch {
	case normalizedCommand == "seed" || normalizedCommand == "minecraft:seed":
		return regexp.MustCompile(`(?i)\bseed\s*:\s*\[?-?\d+\]?`).MatchString(result)
	case normalizedCommand == "difficulty" || normalizedCommand == "minecraft:difficulty":
		return regexp.MustCompile(`(?i)\bdifficulty\s+is\s+(?:peaceful|easy|normal|hard)\b`).MatchString(result)
	case strings.HasPrefix(normalizedCommand, "time query ") || strings.HasPrefix(normalizedCommand, "minecraft:time query "):
		return regexp.MustCompile(`(?i)\btime\s+is\s+\d+\b`).MatchString(result)
	case normalizedCommand == "worldborder get" || normalizedCommand == "minecraft:worldborder get":
		return regexp.MustCompile(`(?i)\bworld\s+border\s+is\s+currently\s+[0-9.e+-]+\s+(?:blocks?|block\(s\))\s+wide\b`).MatchString(result)
	case normalizedCommand == "datapack list enabled" || normalizedCommand == "minecraft:datapack list enabled":
		return regexp.MustCompile(`(?i)\b(?:there\s+(?:are|is)|no)\b.{0,80}\bdata\s+pack(?:\(s\)|s)?\s+enabled\b`).MatchString(result)
	case normalizedCommand == "datapack list available" || normalizedCommand == "minecraft:datapack list available":
		return regexp.MustCompile(`(?i)\b(?:there\s+(?:are|is)|no)\b.{0,100}\bdata\s+pack(?:\(s\)|s)?\s+available\b`).MatchString(result)
	case normalizedCommand == "banlist players" || normalizedCommand == "minecraft:banlist players":
		return regexp.MustCompile(`(?i)\b(?:there\s+(?:are|is)\s+(?:no|\d+)\s+(?:player\s+)?bans?|no\s+(?:player\s+)?bans?|no\s+players?\s+(?:are\s+)?banned|\d+\s+(?:player\s+)?bans?\s*:)\b`).MatchString(result)
	case normalizedCommand == "team list" || normalizedCommand == "minecraft:team list":
		return regexp.MustCompile(`(?i)\b(?:there\s+(?:are|is)|no)\b.{0,100}\bteams?\b`).MatchString(result)
	case normalizedCommand == "scoreboard objectives list" || normalizedCommand == "minecraft:scoreboard objectives list":
		return regexp.MustCompile(`(?i)\b(?:there\s+(?:are|is)|no)\b.{0,100}\bobjectives?\b`).MatchString(result)
	case normalizedCommand == "forceload query" || normalizedCommand == "minecraft:forceload query":
		return regexp.MustCompile(`(?i)\b(?:there\s+(?:are|is)|no)\b.{0,120}\bforce[- ]?loaded\b`).MatchString(result)
	case len(fields) == 2 && verb == "gamerule":
		_, err := parseGameruleReadResult(fields[1], result)
		return err == nil
	}
	switch verb {
	case "list":
		return strings.Contains(lower, "there are") && strings.Contains(lower, "players online")
	case "whitelist":
		return (strings.Contains(lower, "whitelisted player") || strings.Contains(lower, "白名单")) &&
			(strings.Contains(lower, "there are") || strings.Contains(lower, "there is") || strings.Contains(lower, "no whitelisted") || strings.Contains(lower, "白名单"))
	case "tps":
		return strings.Contains(lower, "tps") && !strings.Contains(lower, "please wait")
	case "version":
		return strings.Contains(lower, "this server is running") ||
			strings.Contains(lower, "server version") ||
			strings.Contains(lower, "paper version") ||
			strings.Contains(lower, "minecraft version")
	case "plugins", "pl":
		_, _, complete := loadedPluginInventory(result)
		return complete
	case "mspt":
		return strings.Contains(lower, "mspt") ||
			strings.Contains(lower, "server tick times (avg/min/max)")
	case "title":
		outcome := ClassifyConsoleCommandOutcomeForCommand(command, result, true)
		return outcome.Status == "applied" || outcome.Status == "rejected"
	case "say", "me":
		return strings.Contains(lower, "[server]") ||
			strings.Contains(lower, "broadcast") ||
			ClassifyConsoleCommandOutcome(result).Status != "accepted_unverified"
	default:
		if requireExplicit {
			outcome := ClassifyConsoleCommandOutcomeForCommand(command, result, true)
			return outcome.Status == "applied" || outcome.Status == "rejected"
		}
		return true
	}
}

func consoleResultOutput(verb, output string) string {
	verb = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(verb, "minecraft:")))
	lines := make([]string, 0)
	for _, raw := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		lower := strings.ToLower(line)
		if strings.Contains(lower, "issued server command:") {
			continue
		}
		candidate := strings.TrimSpace(strings.TrimPrefix(line, ">"))
		candidate = strings.TrimSpace(strings.TrimPrefix(candidate, "/"))
		candidateLower := strings.ToLower(candidate)
		if candidateLower == verb || strings.HasPrefix(candidateLower, verb+" ") {
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
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
var consoleMinecraftColor = regexp.MustCompile(`(?i)§[0-9a-fk-orx]`)

func sanitizeConsoleOutput(output string) string {
	output = consoleANSI.ReplaceAllString(output, "")
	output = consoleMinecraftColor.ReplaceAllString(output, "")
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
