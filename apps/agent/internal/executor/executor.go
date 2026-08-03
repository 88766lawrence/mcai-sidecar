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
		emit("", "diagnosis", "å®žä¾‹ä¿¡æ¯åœ¨è®¡åˆ’ç”ŸæˆåŽå‘ç”Ÿäº†å˜åŒ–ï¼›ä¸ºé¿å…å¯¹é”™è¯¯ç‰ˆæœ¬æ‰§è¡Œæ“ä½œï¼ŒAgent å·²æ‹’ç»ç»§ç»­ã€‚")
		emit("FAILED", "policy", "Inventory revision is stale; refresh before retrying")
		return
	}
	if _, err := e.audit.Append("task.execution.started", plan.TaskID, plan.Intent, map[string]any{"instance_ref": plan.InstanceRef}); err != nil {
		emit("", "diagnosis", "æœ¬åœ°å®¡è®¡è®°å½•æ— æ³•å†™å…¥ï¼›å®‰å…¨ç­–ç•¥ç¦æ­¢åœ¨ç¼ºå°‘å®¡è®¡è¯æ®æ—¶ç»§ç»­æ‰§è¡Œã€‚")
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
			emit("", "recovery", fmt.Sprintf("éªŒæ”¶è¿”å›žæš‚æ—¶æ€§å¤±è´¥ï¼›æ­£åœ¨é‡æ–°è°ƒç”¨ %s å¹¶å†æ¬¡éªŒæ”¶ï¼ˆç¬¬ %d/%d æ¬¡ï¼‰", recoveryStep.Tool, attempt+1, e.maxAttempts))
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
		emit("", "recovery", fmt.Sprintf("å®žä¾‹æ¸…å•è¯»å–å‡ºçŽ°æš‚æ—¶æ€§é”™è¯¯ï¼Œæ­£åœ¨è‡ªåŠ¨é‡è¯•ï¼ˆç¬¬ %d/%d æ¬¡ï¼‰", attempt+1, e.maxAttempts))
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
		emit("", "recovery", fmt.Sprintf("%s è¿”å›žæš‚æ—¶æ€§é”™è¯¯ï¼Œæ­£åœ¨è‡ªåŠ¨é‡è¯•ï¼ˆç¬¬ %d/%d æ¬¡ï¼‰", step.Tool, attempt+1, e.maxAttempts))
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
		"inventory revision", "audit write", "forbidden", "ç«¯å£", "å†…å­˜", "æƒé™", "ä¾èµ–",
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
		return "æœåŠ¡å™¨æœªæŽ¥å— Minecraft EULAï¼Œè¿›ç¨‹å› æ­¤æ‹’ç»å¯åŠ¨ã€‚"
	case strings.Contains(combined, "address already in use") || strings.Contains(combined, "failed to bind to port") || strings.Contains(combined, "bind exception"):
		return "æœåŠ¡å™¨ç«¯å£å·²è¢«å…¶ä»–è¿›ç¨‹å ç”¨ï¼ŒMinecraft æ— æ³•å®Œæˆç«¯å£ç»‘å®šã€‚"
	case strings.Contains(combined, "unsupportedclassversionerror") || strings.Contains(combined, "only recognizes class file") || strings.Contains(combined, "could not create the java virtual machine"):
		return "Java è¿è¡Œæ—¶ä¸ŽæœåŠ¡ç«¯æ ¸å¿ƒæˆ–æ’ä»¶è¦æ±‚ä¸å…¼å®¹ã€‚"
	case strings.Contains(combined, "outofmemoryerror") || strings.Contains(combined, "cannot allocate memory") || strings.Contains(combined, "insufficient memory"):
		return "Java è¿›ç¨‹å†…å­˜ä¸è¶³ï¼Œæˆ–å¯åŠ¨å‚æ•°ç”³è¯·çš„å†…å­˜è¶…è¿‡å½“å‰å¯ç”¨èµ„æºã€‚"
	case strings.Contains(combined, "unable to access jarfile") || strings.Contains(combined, "invalid or corrupt jarfile") || strings.Contains(combined, "could not find or load main class"):
		return "å¯åŠ¨ JAR ç¼ºå¤±ã€è·¯å¾„é”™è¯¯æˆ–æ–‡ä»¶å·²æŸåã€‚"
	case strings.Contains(combined, "permission denied") || strings.Contains(combined, "accessdeniedexception"):
		return "å®žä¾‹ç›®å½•æˆ–å¯åŠ¨æ–‡ä»¶æƒé™ä¸è¶³ï¼Œè¿è¡Œç”¨æˆ·æ— æ³•è¯»å–æˆ–å†™å…¥æ‰€éœ€æ–‡ä»¶ã€‚"
	case strings.Contains(combined, "mod resolution encountered") || strings.Contains(combined, "missing mandatory dependencies") || strings.Contains(combined, "requires version"):
		return "æ¨¡ç»„æˆ–æ’ä»¶ä¾èµ–ä¸å®Œæ•´ï¼Œå­˜åœ¨ç¼ºå¤±é¡¹æˆ–ç‰ˆæœ¬å†²çªã€‚"
	case strings.Contains(combined, "exception in server tick loop") || strings.Contains(combined, "crash report") || strings.Contains(combined, "a fatal error"):
		return "Minecraft è¿›ç¨‹å‘ç”Ÿè¿è¡Œæ—¶å´©æºƒï¼Œéœ€è¦ç»“åˆå´©æºƒæŠ¥å‘Šå®šä½å…·ä½“æ¨¡ç»„ã€æ’ä»¶æˆ–é…ç½®ã€‚"
	case state == "stopped" && (strings.Contains(combined, "did not reach running") || strings.Contains(combined, "start request") || strings.Contains(combined, "start timeout")):
		return "å¯åŠ¨è¯·æ±‚å·²ç»å‘å‡ºï¼Œä½†å®žä¾‹ä»å¤„äºŽåœæ­¢çŠ¶æ€ï¼›é¢æ¿å¯åŠ¨å‚æ•°ã€æ ¸å¿ƒæ–‡ä»¶æˆ–è¿è¡ŒçŽ¯å¢ƒå¯èƒ½å­˜åœ¨é”™è¯¯ã€‚"
	default:
		return "å·¥å…·è¿”å›žé”™è¯¯ï¼š" + sanitizeDiagnostic(cause)
	}
}

var sensitiveDiagnostic = regexp.MustCompile(`(?i)(api[_ -]?key|token|secret|password)\s*[:=]\s*\S+`)

func sanitizeDiagnostic(value string) string {
	value = sensitiveDiagnostic.ReplaceAllString(value, "$1=[REDACTED]")
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return "æœªè¿”å›žå¯è¯†åˆ«çš„é”™è¯¯ä¿¡æ¯ï¼Œè¯·æ£€æŸ¥å®žä¾‹æŽ§åˆ¶å°æ—¥å¿—ã€‚"
	}
	if len(value) > 220 {
		value = value[:220] + "â€¦"
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
			listing = listing[:64*1024] + "â€¦"
		}
		emit("", "files", "å®žä¾‹ç›®å½• "+target+"ï¼š "+listing)
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
			emit("", "console", "æŽ§åˆ¶å°è¿”å›žï¼š\n"+sanitizeConsoleOutput(output))
			return nil
		}
		return fmt.Errorf("console command /%s did not produce readable output within the verification window (sha256:%s)", verb, hex.EncodeToString(sum[:8]))
	case "instance.start":
		return e.startInstance(×Nt¶‰žËkºwµçP°ÀÁÉ½Ù¥‘•È¹AÉ½Ù¥‘•È°Á±…¸ÁÉ½Ñ½½°¹Q…Í­A±…¸°ÍÑ•ÀÁÉ½Ñ½½°¹Q…Í­MÑ•À°•µ¥ÐÙ•¹ÑM¥¹¬¤•ÉÉ½Èì(%Á±…Ñ™½É´€èôÍÑÉ¥¹Éœ¡ÍÑ•À¹ÉÌ°€‰Á±…Ñ™½É´ˆ¤(%µ¥¹•É…™ÑY•ÉÍ¥½¸€èôÍÑÉ¥¹Éœ¡ÍÑ•À¹ÉÌ°€‰µ¥¹•É…™Ñ}Ù•ÉÍ¥½¸ˆ¤(%Ñ…É•Ð€èôÍÑÉ¥¹Éœ¡ÍÑ•À¹ÉÌ°€‰Ñ…É•Ðˆ¤(%…•ÁÑU1°|€èôÍÑ•À¹ÉÍl‰…•ÁÑ}•Õ±„‰t¸¡‰½½°¤(%¥˜Ñ…É•Ð€„ô€ˆ½Í•ÉÙ•È¹©…Èˆì($%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰Í•ÉÙ•È¥¹ÍÑ…±±•Èµ…ä½¹±äÝÉ¥Ñ”€½Í•ÉÙ•È¹©…Èˆ¤(%ô(%¥¹ÍÑ…¹”°•ÉÈ€èôÀ¹•Ñ%¹ÍÑ…¹”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜¤(%¥˜•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸•ÉÈ(%ô(%¥˜¥¹ÍÑ…¹”¹MÑ…Ñ”€„ô€‰ÍÑ½ÁÁ•ˆì($%É•ÑÕÉ¸™µÐ¹ÉÉ½É˜ ‰Í•ÉÙ•È¥¹ÍÑ…±±…Ñ¥½¸É•ÅÕ¥É•Ì„ÍÑ½ÁÁ•¥¹ÍÑ…¹”ìÕÉÉ•¹ÐÍÑ…Ñ”¥Ì€•Ìˆ°¥¹ÍÑ…¹”¹MÑ…Ñ”¤(%ô(%…ÉÑ¥™…Ð°•ÉÈ€èô”¹É•±•…Í•I•Í½±Ù•È¹I•Í½±Ù”¡Ñà°Á±…Ñ™½É´°µ¥¹•É…™ÑY•ÉÍ¥½¸¤(%¥˜•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸•ÉÈ(%ô(%¥˜•ÉÈ€èôÀ¹½Ý¹±½…‘É½µUI0¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°…ÉÑ¥™…Ð¹UI0°Ñ…É•Ð¤ì•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸•ÉÈ(%ô(%‘•…‘±¥¹”€èôÑ¥µ”¹9½Ü ¤¹‘ Ì€¨Ñ¥µ”¹5¥¹ÕÑ”¤(%™½ÈÑ¥µ”¹9½Ü ¤¹	•™½É”¡‘•…‘±¥¹”¤ì($%±¥ÍÑ¥¹œ°•ÉÈ€èôÀ¹1¥ÍÑ¥±•Ì¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€ˆ¼ˆ¤($%¥˜•ÉÈ€ôô¹¥°€˜˜ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±¥ÍÑ¥¹œ°€‰Í•ÉÙ•È¹©…Èˆ¤ì($$%‰É•…¬($%ô($%Í•±•Ðì($%…Í”€ðµÑà¹½¹” ¤è($$%É•ÑÕÉ¸Ñà¹ÉÈ ¤($%…Í”€ðµÑ¥µ”¹™Ñ•È È€¨Ñ¥µ”¹M•½¹¤è($%ô(%ô(%±¥ÍÑ¥¹œ°•ÉÈ€èôÀ¹1¥ÍÑ¥±•Ì¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€ˆ¼ˆ¤(%¥˜•ÉÈ€„ô¹¥°ñð€…ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±¥ÍÑ¥¹œ°€‰Í•ÉÙ•È¹©…Èˆ¤ì($%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰½™™¥¥…°‘½Ý¹±½…‘¥¹½ÐÁÉ½‘Õ”€½Í•ÉÙ•È¹©…ÈÝ¥Ñ¡¥¸Ñ¡É•”µ¥¹ÕÑ•Ìˆ¤(%ô(%•µ¥Ð ˆˆ°€‰‘½Ý¹±½…ˆ°™µÐ¹MÁÉ¥¹Ñ˜ ‰½Ý¹±½…‘•½™™¥¥…°€•Ì€•ÌÉ•±•…Í”€•ÌÑ¼€½Í•ÉÙ•È¹©…Èˆ°…ÉÑ¥™…Ð¹A±…Ñ™½É´°…ÉÑ¥™…Ð¹5¥¹•É…™ÑY•ÉÍ¥½¸°…ÉÑ¥™…Ð¹9…µ”¤¤(%¥˜•ÉÈ€èôÀ¹UÁ‘…Ñ•MÑ…ÉÑ½¹™¥œ¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°ÁÉ½Ù¥‘•È¹MÑ…ÉÑ½¹™¥ì($%MÑ…ÉÑ½µµ…¹è€ˆ½ÕÍÈ½‰¥¸½©…Ù„€µaµÌÔÄÉ4€µaµàÉ€µ©…ÈÍ•ÉÙ•È¹©…È¹½Õ¤ˆ°($%MÑ½Á½µµ…¹è€€‰ÍÑ½Àˆ°($%MÑ½ÁQ¥µ•½ÕÐè€€ÌÀ°(%ô¤ì•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸™µÐ¹ÉÉ½É˜ ‰½¹™¥ÕÉ”5¥¹•É…™ÐÍÑ…ÉÐ½µµ…¹è€•Üˆ°•ÉÈ¤(%ô(%•µ¥Ð ˆˆ°€‰¥¹ÍÑ…¹”ˆ°€‰½¹™¥ÕÉ•Ñ¡”5¥¹•É…™ÐÍÑ…ÉÐ½µµ…¹ˆ¤(%¥˜€……•ÁÑU1ì($%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰5¥¹•É…™ÐU1…•ÁÑ…¹”¥ÌÉ•ÅÕ¥É•‰•™½É”ÍÑ…ÉÐìÑ¡”ÕÍ•ÈµÕÍÐ•áÁ±¥¥Ñ±ä…É•”Ñ¼Ñ¡”5¥¹•É…™ÐU1ˆ¤(%ô(%•Õ±„€èômu‰åÑ” ˆŒ•ÁÑ••áÁ±¥¥Ñ±ä‰äÑ¡”Í•ÉÙ•È…‘µ¥¹¥ÍÑÉ…Ñ½ÈÑ¡É½Õ 5%q¹•Õ±„õÑÉÕ•q¸ˆ¤(%¥˜•ÉÈ€èôÀ¹]É¥Ñ•¥±”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€‰•Õ±„¹ÑáÐˆ°•Õ±„¤ì•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸™µÐ¹ÉÉ½É˜ ‰ÝÉ¥Ñ”5¥¹•É…™ÐU1…•ÁÑ…¹”è€•Üˆ°•ÉÈ¤(%ô(%É•…‘	…¬°•ÉÈ€èôÀ¹I•…‘¥±”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€‰•Õ±„¹ÑáÐˆ¤(%¥˜•ÉÈ€„ô¹¥°ñð€…¡…Í•ÁÑ•‘U1¡É•…‘	…¬¤ì($%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰5¥¹•É…™ÐU1…•ÁÑ…¹”É•…µ‰…¬Ù•É¥™¥…Ñ¥½¸™…¥±•ˆ¤(%ô(%•µ¥Ð ˆˆ°€‰•Õ±„ˆ°€‹–ÞËš‚çš6»žº‡žB–Fcžjšb;ž†»š:#šv–g–—–æÛ¦ª3¢¾€½•Õ±„¹ÑáÓ¾òi•Õ±„õÑÉÕ”ˆ¤(%¥˜•ÉÈ€èôÀ¹MÑ…ÉÐ¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜¤ì•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸•ÉÈ(%ô(%•µ¥Ð ˆˆ°€‰¥¹ÍÑ…¹”ˆ°€‰MÑ…ÉÐÉ•ÅÕ•ÍÐ…•ÁÑ•‰äÑ¡”Á…¹•°ˆ¤(%É•ÑÕÉ¸¹¥°)ô()™Õ¹Œ¡…Í•ÁÑ•‘U1¡½¹Ñ•¹ÑÌmu‰åÑ”¤‰½½°ì(%™½È|°±¥¹”€èôÉ…¹”ÍÑÉ¥¹Ì¹MÁ±¥Ð¡ÍÑÉ¥¹œ¡½¹Ñ•¹ÑÌ¤°€‰q¸ˆ¤ì($%¥˜ÍÑÉ¥¹Ì¹ÅÕ…±½±¡ÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡±¥¹”¤°€‰•Õ±„õÑÉÕ”ˆ¤ì($$%É•ÑÕÉ¸ÑÉÕ”($%ô(%ô(%É•ÑÕÉ¸™…±Í”)ô()™Õ¹Œ€¡”€©á•ÕÑ½È¤½¹™¥A…Ñ ¡Ñà½¹Ñ•áÐ¹½¹Ñ•áÐ°ÀÁÉ½Ù¥‘•È¹AÉ½Ù¥‘•È°Á±…¸ÁÉ½Ñ½½°¹Q…Í­A±…¸°ÍÑ•ÀÁÉ½Ñ½½°¹Q…Í­MÑ•À°•µ¥ÐÙ•¹ÑM¥¹¬¤•ÉÉ½Èì(%Ñ…É•Ð°•ÉÈ€èôÍ•ÕÉ¥Ñä¹9½Éµ…±¥é•I•±…Ñ¥Ù”¡ÍÑÉ¥¹Éœ¡ÍÑ•À¹ÉÌ°€‰Á…Ñ ˆ¤¤(%¥˜•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸•ÉÈ(%ô(%‰•™½É”°•ÉÈ€èôÀ¹I•…‘¥±”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°Ñ…É•Ð¤(%¥˜•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸•ÉÈ(%ô(%¥˜±•¸¡‰•™½É”¤€ø€ÈððÈÀì($%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰½¹™¥ÕÉ…Ñ¥½¸™¥±”•á••‘ÌÑ¡”€È5¥±¥µ¥Ðˆ¤(%ô(%Á…Ñ¡•Ì°½¬€èôÍÑ•À¹ÉÍl‰Á…Ñ ‰t¸¡mu…¹ä¤(%¥˜€…½¬ñð±•¸¡Á…Ñ¡•Ì¤€„ô€Äì($%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰•á…Ñ±ä½¹”ÍÑÉÕÑÕÉ•ÁÉ½Á•ÉÑäÁ…Ñ ¥ÌÉ•ÅÕ¥É•ˆ¤(%ô(%Á…Ñ °½¬€èôÁ…Ñ¡•ÍlÁt¸¡µ…ÁmÍÑÉ¥¹u…¹ä¤(%¥˜€…½¬ñðÍÑÉ¥¹Éœ¡Á…Ñ °€‰½Àˆ¤€„ô€‰É•Á±…”ˆì($%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰Õ¹ÍÕÁÁ½ÉÑ•Á…Ñ ½Á•É…Ñ¥½¸ˆ¤(%ô(%…™Ñ•È°•ÉÈ€èôÁ…Ñ¡AÉ½Á•ÉÑ¥•Ì¡‰•™½É”°ÍÑÉ¥¹Éœ¡Á…Ñ °€‰­•äˆ¤°Á…Ñ¡l‰Ù…±Õ”‰t¤(%¥˜•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸•ÉÈ(%ô(%Í¹…ÁÍ¡½Ñ¥È€èô™¥±•Á…Ñ ¹)½¥¸¡”¹‘…Ñ…¥È°€‰Í¹…ÁÍ¡½ÑÌˆ°Á±…¸¹Q…Í­%¤(%¥˜•ÉÈ€èô½Ì¹5­‘¥É±°¡Í¹…ÁÍ¡½Ñ¥È°€Á¼ÜÀÀ¤ì•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸•ÉÈ(%ô(%Í¹…ÁÍ¡½ÑA…Ñ €èô™¥±•Á…Ñ ¹)½¥¸¡Í¹…ÁÍ¡½Ñ¥È°ÍÑÉ¥¹Ì¹I•Á±…•±°¡ÍÑÉ¥¹Ì¹QÉ¥µAÉ•™¥à¡Ñ…É•Ð°€ˆ¼ˆ¤°€ˆ¼ˆ°€‰|ˆ¤¤(%¥˜•ÉÈ€èô½Ì¹]É¥Ñ•¥±”¡Í¹…ÁÍ¡½ÑA…Ñ °‰•™½É”°€Á¼ØÀÀ¤ì•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸™µÐ¹ÉÉ½É˜ ‰Í¹…ÁÍ¡½Ðè€•Üˆ°•ÉÈ¤(%ô(%‰•™½É•!…Í °…™Ñ•É!…Í €èôÍ¡„ÈÔØ¹MÕ´ÈÔØ¡‰•™½É”¤°Í¡„ÈÔØ¹MÕ´ÈÔØ¡…™Ñ•È¤(%•µ¥Ð ˆˆ°€‰Í¹…ÁÍ¡½Ðˆ°™µÐ¹MÁÉ¥¹Ñ˜ ‰É•…Ñ•LÄÍ¹…ÁÍ¡½Ð€•Ìˆ°™¥±•Á…Ñ ¹	…Í”¡Í¹…ÁÍ¡½ÑA…Ñ ¤¤¤(%¥˜•ÉÈ€èôÀ¹]É¥Ñ•¥±”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°Ñ…É•Ð°…™Ñ•È¤ì•ÉÈ€„ô¹¥°ì($%É•ÑÕÉ¸•ÉÈ(%ô(%É•…‘	…¬°•ÉÈ€èôÀ¹I•…‘¥±”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°Ñ…É•Ð¤(%¥˜•ÉÈ€„ô¹¥°ñðÍ¡„ÈÔØ¹MÕ´ÈÔØ¡É•…‘	…¬¤€„ô…™Ñ•É!…Í ì($%¥˜É•ÍÑ½É•ÉÈ€èôÀ¹]É¥Ñ•¥±”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°Ñ…É•Ð°‰•™½É”¤ìÉ•ÍÑ½É•ÉÈ€„ô¹¥°ì($$%É•ÑÕÉ¸™µÐ¹ÉÉ½É˜ ‰Ù•É¥™¥…Ñ¥½¸™…¥±•…¹É½±±‰…¬™…¥±•è€•Øˆ°É•ÍÑ½É•ÉÈ¤($%ô($%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰Í•µ…¹Ñ¥ŒÉ•…µ‰…¬™…¥±•ìÑ¡”½É¥¥¹…°Í¹…ÁÍ¡½ÐÝ…ÌÉ•ÍÑ½É•ˆ¤(%ô(%”¹…Õ‘¥Ð¹ÁÁ•¹ ‰½¹™¥œ¹Á…Ñ ¹½µµ¥ÑÑ•ˆ°Á±…¸¹Q…Í­%°Ñ…É•Ð°µ…ÁmÍÑÉ¥¹u…¹åì‰‰•™½É•}Í¡„ÈÔØˆè¡•à¹¹½‘•Q½MÑÉ¥¹œ¡‰•™½É•!…Í¡lét¤°€‰…™Ñ•É}Í¡„ÈÔØˆè¡•à¹¹½‘•Q½MÑÉ¥¹œ¡…™Ñ•É!…Í¡lét¥ô¤(%•µ¥Ð ˆˆ°€‰½¹™¥œˆ°™µÐ¹MÁÉ¥¹Ñ˜ ‰A…Ñ¡•€•Ì…¹Ù•É¥™¥•Í¡„ÈÔØè•Ìˆ°Ñ…É•Ð°¡•à¹¹½‘•Q½MÑÉ¥¹œ¡…™Ñ•É!…Í¡lèát¤¤¤(%É•ÑÕÉ¸¹¥°)ô()™Õ¹Œ€¡”€©á•ÕÑ½È¤Ù•É¥™ä¡Ñà½¹Ñ•áÐ¹½¹Ñ•áÐ°ÀÁÉ½Ù¥‘•È¹AÉ½Ù¥‘•È°Á±…¸ÁÉ½Ñ½½°¹Q…Í­A±…¸¤•ÉÉ½Èì(%™½È|°ÉÕ±”€èôÉ…¹”Á±…¸¹•ÁÑ…¹”ì($%¥˜ÉÕ±”¹QåÁ”€ôô€‰¥¹ÍÑ…¹•}ÍÑ…Ñ”ˆì($$%‘•…‘±¥¹”€èôÑ¥µ”¹9½Ü ¤¹‘ È€¨Ñ¥µ”¹5¥¹ÕÑ”¤($$%™½ÈÑ¥µ”¹9½Ü ¤¹	•™½É”¡‘•…‘±¥¹”¤ì($$$%¥¹ÍÑ…¹”°•ÉÈ€èôÀ¹•Ñ%¹ÍÑ…¹”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜¤($$$%¥˜•ÉÈ€ôô¹¥°€˜˜¥¹ÍÑ…¹”¹MÑ…Ñ”€ôôÉÕ±”¹áÁ•Ñ•ì($$$$%‰É•…¬($$$%ô($$$%Í•±•Ðì($$$%…Í”€ðµÑà¹½¹” ¤è($$$$%É•ÑÕÉ¸Ñà¹ÉÈ ¤($$$%…Í”€ðµÑ¥µ”¹™Ñ•È È€¨Ñ¥µ”¹M•½¹¤è($$$%ô($$%ô($$%¥¹ÍÑ…¹”°•ÉÈ€èôÀ¹•Ñ%¹ÍÑ…¹”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜¤($$%¥˜•ÉÈ€„ô¹¥°ñð¥¹ÍÑ…¹”¹MÑ…Ñ”€„ôÉÕ±”¹áÁ•Ñ•ì($$$%É•ÑÕÉ¸™µÐ¹ÉÉ½É˜ ‰¥¹ÍÑ…¹”‘¥¹½ÐÉ•… €•Ìˆ°ÉÕ±”¹áÁ•Ñ•¤($$%ô($%ô($%¥˜ÉÕ±”¹QåÁ”€ôô€‰Í•ÉÙ•É}É•…‘äˆì($$%‘•…‘±¥¹”€èôÑ¥µ”¹9½Ü ¤¹‘ Ì€¨Ñ¥µ”¹5¥¹ÕÑ”¤($$%™½ÈÑ¥µ”¹9½Ü ¤¹	•™½É”¡‘•…‘±¥¹”¤ì($$$%¥¹ÍÑ…¹”°¥¹ÍÑ…¹•ÉÈ€èôÀ¹•Ñ%¹ÍÑ…¹”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜¤($$$%½ÕÑÁÕÐ°½ÕÑÁÕÑÉÈ€èôÀ¹I•…‘=ÕÑÁÕÐ¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€ÈÔØ¤($$$%¥˜½ÕÑÁÕÑÉÈ€ôô¹¥°€˜˜¥ÍM•ÉÙ•ÉI•…‘ä¡½ÕÑÁÕÐ¤ì($$$$%‰É•…¬($$$%ô($$$%¥˜½ÕÑÁÕÑÉÈ€ôô¹¥°€˜˜ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡ÍÑÉ¥¹Ì¹Q½1½Ý•È¡±…Ñ•ÍÑM•ÉÙ•ÉÑÑ•µÁÐ¡½ÕÑÁÕÐ¤¤°€‰•Õ±„ˆ¤ì($$$$%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰Í•ÉÙ•ÈÉ•ÅÕ¥É•Ì5¥¹•É…™ÐU1…•ÁÑ…¹”‰•™½É”¥Ð…¸ÍÑ…ÉÐˆ¤($$$%ô($$$%¥˜¥¹ÍÑ…¹•ÉÈ€ôô¹¥°€˜˜¥¹ÍÑ…¹”¹MÑ…Ñ”€ôô€‰ÍÑ½ÁÁ•ˆ€˜˜¡…ÍQ•Éµ¥¹…±MÑ…ÉÑÕÁ…¥±ÕÉ”¡½ÕÑÁÕÐ¤ì($$$$%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰Í•ÉÙ•ÈÍÑ½ÁÁ•‰•™½É”É•…¡¥¹œ¥ÑÌÉ•…‘äÍ¥¹…°ˆ¤($$$%ô($$$%Í•±•Ðì($$$%…Í”€ðµÑà¹½¹” ¤è($$$$%É•ÑÕÉ¸Ñà¹ÉÈ ¤($$$%…Í”€ðµÑ¥µ”¹™Ñ•È È€¨Ñ¥µ”¹M•½¹¤è($$$%ô($$%ô($$%|°¥¹ÍÑ…¹•ÉÈ€èôÀ¹•Ñ%¹ÍÑ…¹”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜¤($$%½ÕÑÁÕÐ°½ÕÑÁÕÑÉÈ€èôÀ¹I•…‘=ÕÑÁÕÐ¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€ÈÔØ¤($$%¥˜¥¹ÍÑ…¹•ÉÈ€„ô¹¥°ñð½ÕÑÁÕÑÉÈ€„ô¹¥°ñð€…¥ÍM•ÉÙ•ÉI•…‘ä¡½ÕÑÁÕÐ¤ì($$$%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰Í•ÉÙ•È‘¥¹½ÐÉ•… Ñ¡”5¥¹•É…™ÐÉ•…‘äÍ¥¹…°Ý¥Ñ¡¥¸Ñ¡É•”µ¥¹ÕÑ•Ìˆ¤($$%ô($%ô($%¥˜ÉÕ±”¹QåÁ”€ôô€‰Á±Õ¥¹}•¹…‰±•ˆì($$%¥¹ÍÑ…¹”°•ÉÈ€èôÀ¹•Ñ%¹ÍÑ…¹”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜¤($$%¥˜•ÉÈ€„ô¹¥°ñð¥¹ÍÑ…¹”¹MÑ…Ñ”€„ô€‰ÉÕ¹¹¥¹œˆì($$$%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰Á±Õ¥¸…•ÁÑ…¹”É•ÅÕ¥É•Ì„ÉÕ¹¹¥¹œ¥¹ÍÑ…¹”ˆ¤($$%ô($$%‰…Í•±¥¹”°‰…Í•±¥¹•ÉÈ€èôÀ¹I•…‘=ÕÑÁÕÐ¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€ÈÔØ¤($$%±½	…Í•±¥¹”°±½	…Í•±¥¹•ÉÈ€èôÀ¹I•…‘¥±”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€‰±½Ì½±…Ñ•ÍÐ¹±½œˆ¤($$%¥˜‰…Í•±¥¹•ÉÈ€„ô¹¥°€˜˜±½	…Í•±¥¹•ÉÈ€„ô¹¥°ì($$$%É•ÑÕÉ¸•ÉÉ½ÉÌ¹9•Ü ‰Á±Õ¥¸…•ÁÑ…¹”…¹¹½ÐÉ•…½¹Í½±”½ÕÑÁÕÐ½È±…Ñ•ÍÐ¹±½œˆ¤($$%ô($$%¥˜•ÉÈ€èôÀ¹M•¹‘½µµ…¹¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€‰Á±Õ¥¹Ìˆ¤ì•ÉÈ€„ô¹¥°ì($$$%É•ÑÕÉ¸™µÐ¹ÉÉ½É˜ ‰ÅÕ•Éä±½…‘•Á±Õ¥¹Ìè€•Üˆ°•ÉÈ¤($$%ô($$%É•ÍÕ±Ð€èô”¹Ý…¥Ñ½É½¹Í½±•=ÕÑÁÕÐ ($$$%Ñà°À°Á±…¸¹%¹ÍÑ…¹•I•˜°€‰Á±Õ¥¹Ìˆ°‰…Í•±¥¹”°ÍÑÉ¥¹œ¡±½	…Í•±¥¹”¤°($$$%‰…Í•±¥¹•ÉÈ€ôô¹¥°°±½	…Í•±¥¹•ÉÈ€ôô¹¥°°($$$¤($$%±…Ñ•ÍÑ1½œ°|€èôÀ¹I•…‘¥±”¡Ñà°Á±…¸¹%¹ÍÑ…¹•I•˜°€‰±½Ì½±…Ñ•ÍÐ¹±½œˆ¤($$%¥˜€…½¹Ñ…¥¹ÍA±Õ¥¹Ù¥‘•¹”¡É•ÍÕ±Ð¬‰q¸ˆ­ÍÑÉ¥¹œ¡±…Ñ•ÍÑ1½œ¤°ÉÕ±”¹9…µ”¤ì($$$%É•ÑÕÉ¸™µÐ¹ÉÉ½É˜ ‰Á±Õ¥¸€•ÌÝ…Ì¹½ÐÁÉ•Í•¹Ð¥¸½¹Í½±”½ÈÍÑ…ÉÑÕÀµ±½œ•Ù¥‘•¹”ˆ°ÉÕ±”¹9…µ”¤($$%ô($%ô(%ô(%É•ÑÕÉ¸¹¥°)ô()™Õ¹ŒÁ±…¹!…ÍQ½½°¡Á±…¸ÁÉ½Ñ½½°¹Q…Í­A±…¸°Ñ½½°ÍÑÉ¥¹œ¤‰½½°ì(%™½È|°ÍÑ•À€èôÉ…¹”Á±…¸¹MÑ•ÁÌì($%¥˜ÍÑ•À¹Q½½°€ôôÑ½½°ì($$%É•ÑÕÉ¸ÑÉÕ”($%ô(%ô(%É•ÑÕÉ¸™…±Í”)ô()™Õ¹Œ½¹Ñ…¥¹ÍA±Õ¥¹Ù¥‘•¹”¡½ÕÑÁÕÐ°ÁÉ½©•ÐÍÑÉ¥¹œ¤‰½½°ì(%±½Ý•È€èôÍÑÉ¥¹Ì¹Q½1½Ý•È¡½ÕÑÁÕÐ¤(%¹…µ•Ì€èômuÍÑÉ¥¹íÍÑÉ¥¹Ì¹Q½1½Ý•È¡ÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡ÁÉ½©•Ð¤¥ô(%¥˜¹…µ•ÍlÁt€ôô€‰•ÍÍ•¹Ñ¥…±Íàˆì($%¹…µ•Ì€ô…ÁÁ•¹¡¹…µ•Ì°€‰•ÍÍ•¹Ñ¥…±Ìˆ¤(%ô(%™½È|°¹…µ”€èôÉ…¹”¹…µ•Ìì($%¥˜¹…µ”€ôô€ˆˆì($$%½¹Ñ¥¹Õ”($%ô($%¥˜ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰•¹…‰±¥¹œ€ˆ­¹…µ”¤ñðÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Á±Õ¥¹Ì€ ˆ¤€˜˜ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°¹…µ”¤ñðÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Í•ÉÙ•ÈÁ±Õ¥¹Ìˆ¤€˜˜ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°¹…µ”¤ì($$%É•ÑÕÉ¸ÑÉÕ”($%ô(%ô(%É•ÑÕÉ¸™…±Í”)ô()™Õ¹Œ¥ÍM•ÉÙ•ÉI•…‘ä¡½ÕÑÁÕÐÍÑÉ¥¹œ¤‰½½°ì(%±½Ý•È€èôÍÑÉ¥¹Ì¹Q½1½Ý•È¡±…Ñ•ÍÑM•ÉÙ•ÉÑÑ•µÁÐ¡½ÕÑÁÕÐ¤¤(%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰‘½¹”€ ˆ¤ñðÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰™½È¡•±À°ÑåÁ”p‰¡•±Ápˆˆ¤)ô((¼¼±…Ñ•ÍÑM•ÉÙ•ÉÑÑ•µÁÐÁÉ•Ù•¹ÑÌ„ÁÉ¥½È±…Õ¹ Ì•ÉÉ½ÉÌ½ÈÉ•…‘äÍ¥¹…°™É½´(¼¼‰•¥¹œ¥¹Ñ•ÉÁÉ•Ñ•…Ì•Ù¥‘•¹”™½ÈÑ¡”±…Õ¹ ÕÉÉ•¹Ñ±ä‰•¥¹œÙ•É¥™¥•¸)™Õ¹Œ±…Ñ•ÍÑM•ÉÙ•ÉÑÑ•µÁÐ¡½ÕÑÁÕÐÍÑÉ¥¹œ¤ÍÑÉ¥¹œì(%±½Ý•È€èôÍÑÉ¥¹Ì¹Q½1½Ý•È¡½ÕÑÁÕÐ¤(%µ…É­•ÉÌ€èômuÍÑÉ¥¹ì($$ˆø€½ÕÍÈ½‰¥¸½©…Ù„ˆ°($$‰m‰½½ÑÍÑÉ…ÁtÉÕ¹¹¥¹œ©…Ù„ˆ°($$‰ÍÑ…ÉÑ¥¹œ½Éœ¹‰Õ­­¥Ð¹É…™Ñ‰Õ­­¥Ð¹µ…¥¸ˆ°($$‰ÍÑ…ÉÑ¥¹œµ¥¹•É…™ÐÍ•ÉÙ•ÈÙ•ÉÍ¥½¸ˆ°(%ô(%ÍÑ…ÉÐ€èô€´Ä(%™½È|°µ…É­•È€èôÉ…¹”µ…É­•ÉÌì($%¥˜¥¹‘•à€èôÍÑÉ¥¹Ì¹1…ÍÑ%¹‘•à¡±½Ý•È°µ…É­•È¤ì¥¹‘•à€øÍÑ…ÉÐì($$%ÍÑ…ÉÐ€ô¥¹‘•à($%ô(%ô(%¥˜ÍÑ…ÉÐ€ð€Àì($%É•ÑÕÉ¸½ÕÑÁÕÐ(%ô(%É•ÑÕÉ¸½ÕÑÁÕÑmÍÑ…ÉÐét)ô()™Õ¹Œ¡…ÍQ•Éµ¥¹…±MÑ…ÉÑÕÁ…¥±ÕÉ”¡½ÕÑÁÕÐÍÑÉ¥¹œ¤‰½½°ì(%±½Ý•È€èôÍÑÉ¥¹Ì¹Q½1½Ý•È¡±…Ñ•ÍÑM•ÉÙ•ÉÑÑ•µÁÐ¡½ÕÑÁÕÐ¤¤(%™½È|°Í¥¹…°€èôÉ…¹”muÍÑÉ¥¹ì($$‰¥¹Ù…±¥½È½ÉÉÕÁÐ©…Èˆ°€‰Õ¹…‰±”Ñ¼…•ÍÌ©…É™¥±”ˆ°€‰…‘‘É•ÍÌ…±É•…‘ä¥¸ÕÍ”ˆ°($$‰™…¥±•Ñ¼‰¥¹ˆ°€‰Õ¹ÍÕÁÁ½ÉÑ•‘±…ÍÍÙ•ÉÍ¥½¸ˆ°€‰½ÕÑ½™µ•µ½Éäˆ°€‰Á•Éµ¥ÍÍ¥½¸‘•¹¥•ˆ°($$‰½Õ±¹½ÐÉ•…Ñ”Ñ¡”©…Ù„Ù¥ÉÑÕ…°µ…¡¥¹”ˆ°€‰•á•ÁÑ¥½¸¥¸Í•ÉÙ•ÈÑ¥¬±½½Àˆ°€‰É…Í É•Á½ÉÐˆ°(%ôì($%¥˜ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°Í¥¹…°¤ì($$%É•ÑÕÉ¸ÑÉÕ”($%ô(%ô(%É•ÑÕÉ¸™…±Í”)ô()™Õ¹Œ€¡”€©á•ÕÑ½È¤É•Í½±Ù”¡É•˜ÍÑÉ¥¹œ¤€¡ÁÉ½Ù¥‘•È¹AÉ½Ù¥‘•È°•ÉÉ½È¤ì(%ÁÉ•™¥à€èôÍÑÉ¥¹Ì¹MÁ±¥Ñ8¡É•˜°€ˆèˆ°€È¥lÁt(%À€èô”¹ÁÉ½Ù¥‘•ÉÍmÁÉ•™¥át(%¥˜À€ôô¹¥°ì($%É•ÑÕÉ¸¹¥°°™µÐ¹ÉÉ½É˜ ‰¹¼ÁÉ½Ù¥‘•ÈÉ•¥ÍÑ•É•™½È€•Äˆ°ÁÉ•™¥à¤(%ô(%É•ÑÕÉ¸À°¹¥°)ô()™Õ¹ŒÍÑÉ¥¹Éœ¡…ÉÌµ…ÁmÍÑÉ¥¹u…¹ä°­•äÍÑÉ¥¹œ¤ÍÑÉ¥¹œìÙ…±Õ”°|€èô…ÉÍm­•åt¸¡ÍÑÉ¥¹œ¤ìÉ•ÑÕÉ¸Ù…±Õ”ô()™Õ¹ŒÙ…±¥‘…Ñ•½¹Í½±•½µµ…¹¡ÍÑ•ÀÁÉ½Ñ½½°¹Q…Í­MÑ•À¤€¡ÍÑÉ¥¹œ°ÍÑÉ¥¹œ°•ÉÉ½È¤ì(%½µµ…¹€èôÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡ÍÑÉ¥¹Ì¹QÉ¥µAÉ•™¥à¡ÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡ÍÑÉ¥¹Éœ¡ÍÑ•À¹ÉÌ°€‰½µµ…¹ˆ¤¤°€ˆ¼ˆ¤¤(%¥˜½µµ…¹€ôô€ˆˆì($%É•ÑÕÉ¸€ˆˆ°€ˆˆ°•ÉÉ½ÉÌ¹9•Ü ‰½¹Í½±”½µµ…¹µÕÍÐ¹½Ð‰”•µÁÑäˆ¤(%ô(%¥˜±•¸¡mu‰åÑ”¡½µµ…¹¤¤€ø€ÈÔØì($%É•ÑÕÉ¸€ˆˆ°€ˆˆ°•ÉÉ½ÉÌ¹9•Ü ‰½¹Í½±”½µµ…¹•á••‘ÌÑ¡”€ÈÔØµ‰åÑ”±¥µ¥Ðˆ¤(%ô(%¥˜ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Í¹ä¡½µµ…¹°€‰qÉq¸ˆ¤ñðÍÑÉ¥¹Ì¹%¹‘•áÕ¹Œ¡½µµ…¹°Õ¹¥½‘”¹%Í½¹ÑÉ½°¤€øô€Àì($%É•ÑÕÉ¸€ˆˆ°€ˆˆ°•ÉÉ½ÉÌ¹9•Ü ‰½¹Í½±”½µµ…¹µÕÍÐ‰”„Í¥¹±”ÁÉ¥¹Ñ…‰±”±¥¹”ˆ¤(%ô(%™¥•±‘Ì€èôÍÑÉ¥¹Ì¹¥•±‘Ì¡½µµ…¹¤(%Ù•Éˆ€èôÍÑÉ¥¹Ì¹Q½1½Ý•È¡ÍÑÉ¥¹Ì¹QÉ¥µAÉ•™¥à¡™¥•±‘ÍlÁt°€‰µ¥¹•É…™Ðèˆ¤¤(%¥˜Ù•Éˆ€ôô€‰ÍÑ½ÀˆñðÙ•Éˆ€ôô€‰É•ÍÑ…ÉÐˆñðÙ•Éˆ€ôô€‰ÅÕ¥ÐˆñðÙ•Éˆ€ôô€‰•¹ˆì($%É•ÑÕÉ¸€ˆˆ°€ˆˆ°•ÉÉ½ÉÌ¹9•Ü ‰Í•ÉÙ•È±¥™•å±”½µµ…¹‘ÌµÕÍÐÕÍ”Ñ¡”‘•‘¥…Ñ•¥¹ÍÑ…¹”Ñ½½°ˆ¤(%ô(%É•ÅÕ¥É•‘I¥Í¬€èô½¹Í½±•½µµ…¹‘I¥Í¬¡Ù•Éˆ¤(%¥˜½¹Í½±•I¥Í­I…¹¬¡ÍÑ•À¹I¥Í¬¤€ð½¹Í½±•I¥Í­I…¹¬¡É•ÅÕ¥É•‘I¥Í¬¤ì($%É•ÑÕÉ¸€ˆˆ°€ˆˆ°™µÐ¹ÉÉ½É˜ ‰½¹Í½±”½µµ…¹€¼•ÌÉ•ÅÕ¥É•Ì€•ÌÉ¥Í¬°½Ð€•Ìˆ°Ù•Éˆ°É•ÅÕ¥É•‘I¥Í¬°ÍÑ•À¹I¥Í¬¤(%ô(%¥˜½¹Í½±•I¥Í­I…¹¬¡É•ÅÕ¥É•‘I¥Í¬¤€øô½¹Í½±•I¥Í­I…¹¬ ‰µ•‘¥Õ´ˆ¤€˜˜€…ÍÑ•À¹I•ÅÕ¥É•Í½¹™¥Éµ…Ñ¥½¸ì($%É•ÑÕÉ¸€ˆˆ°€ˆˆ°™µÐ¹ÉÉ½É˜ ‰½¹Í½±”½µµ…¹€¼•ÌÉ•ÅÕ¥É•Ì•áÁ±¥¥Ð½¹™¥Éµ…Ñ¥½¸ˆ°Ù•Éˆ¤(%ô(%É•ÑÕÉ¸½µµ…¹°É•ÅÕ¥É•‘I¥Í¬°¹¥°)ô()™Õ¹Œ½¹Í½±•½µµ…¹‘I¥Í¬¡Ù•ÉˆÍÑÉ¥¹œ¤ÍÑÉ¥¹œì(%ÍÝ¥Ñ Ù•Éˆì(%…Í”€‰±¥ÍÐˆ°€‰¡•±Àˆ°€‰Ù•ÉÍ¥½¸ˆ°€‰Á±Õ¥¹Ìˆ°€‰Á°ˆ°€‰ÑÁÌˆ°€‰µÍÁÐˆ°€‰Í••ˆè($%É•ÑÕÉ¸€‰É•…ˆ(%…Í”€‰Í…äˆ°€‰µ”ˆè($%É•ÑÕÉ¸€‰±½Üˆ(%…Í”€‰Ñ¥µ”ˆ°€‰Ý•…Ñ¡•Èˆ°€‰‘¥™™¥Õ±Ñäˆ°€‰…µ•ÉÕ±”ˆ°€‰…µ•µ½‘”ˆ°€‰¥Ù”ˆ°€‰±•…Èˆ°€‰ÑÀˆ°€‰Ñ•±•Á½ÉÐˆ°€‰•™™•Ðˆ°€‰•¹¡…¹Ðˆ°€‰áÀˆ°€‰•áÁ•É¥•¹”ˆ°€‰Í•ÑÝ½É±‘ÍÁ…Ý¸ˆ°€‰ÍÁ…Ý¹Á½¥¹Ðˆè($%É•ÑÕÉ¸€‰µ•‘¥Õ´ˆ(%‘•™…Õ±Ðè($%É•ÑÕÉ¸€‰¡¥ ˆ(%ô)ô()™Õ¹Œ½¹Í½±•I¥Í­I…¹¬¡É¥Í¬ÍÑÉ¥¹œ¤¥¹Ðì(%ÍÝ¥Ñ É¥Í¬ì(%…Í”€‰É•…ˆè($%É•ÑÕÉ¸€À(%…Í”€‰±½Üˆè($%É•ÑÕÉ¸€Ä(%…Í”€‰µ•‘¥Õ´ˆè($%É•ÑÕÉ¸€È(%…Í”€‰¡¥ ˆè($%É•ÑÕÉ¸€Ì(%‘•™…Õ±Ðè($%É•ÑÕÉ¸€´Ä(%ô)ô()™Õ¹Œ€¡”€©á•ÕÑ½È¤Ý…¥Ñ½É½¹Í½±•=ÕÑÁÕÐ (%Ñà½¹Ñ•áÐ¹½¹Ñ•áÐ°(%ÀÁÉ½Ù¥‘•È¹AÉ½Ù¥‘•È°(%¥¹ÍÑ…¹•I•˜°Ù•Éˆ°½ÕÑÁÕÑ	…Í•±¥¹”°±½	…Í•±¥¹”ÍÑÉ¥¹œ°(%ÕÍ•A…¹•±=ÕÑÁÕÐ°ÕÍ•1…Ñ•ÍÑ1½œ‰½½°°(¤ÍÑÉ¥¹œì(%½¹ÍÐ…ÑÑ•µÁÑÌ€ô€ÈÐ(%™½È…ÑÑ•µÁÐ€èô€Àì…ÑÑ•µÁÐ€ð…ÑÑ•µÁÑÌì…ÑÑ•µÁÐ¬¬ì($%¥˜ÕÍ•A…¹•±=ÕÑÁÕÐì($$%½ÕÑÁÕÐ°•ÉÈ€èôÀ¹I•…‘=ÕÑÁÕÐ¡Ñà°¥¹ÍÑ…¹•I•˜°€ÈÔØ¤($$%¥˜•ÉÈ€ôô¹¥°ì($$$%¥˜‘•±Ñ„€èô½¹Í½±•=ÕÑÁÕÑ•±Ñ„¡½ÕÑÁÕÑ	…Í•±¥¹”°½ÕÑÁÕÐ¤ì‘•±Ñ„€„ô€ˆˆì($$$$%¥˜½¹Í½±•Ù¥‘•¹•½µÁ±•Ñ”¡Ù•Éˆ°‘•±Ñ„¤ì($$$$$%É•ÑÕÉ¸‘•±Ñ„($$$$%ô($$$%ô($$%ô($%ô($%¥˜ÕÍ•1…Ñ•ÍÑ1½œì($$%½ÕÑÁÕÐ°•ÉÈ€èôÀ¹I•…‘¥±”¡Ñà°¥¹ÍÑ…¹•I•˜°€‰±½Ì½±…Ñ•ÍÐ¹±½œˆ¤($$%¥˜•ÉÈ€ôô¹¥°ì($$$%¥˜‘•±Ñ„€èô½¹Í½±•=ÕÑÁÕÑ•±Ñ„¡±½	…Í•±¥¹”°ÍÑÉ¥¹œ¡½ÕÑÁÕÐ¤¤ì‘•±Ñ„€„ô€ˆˆì($$$$%¥˜½¹Í½±•Ù¥‘•¹•½µÁ±•Ñ”¡Ù•Éˆ°‘•±Ñ„¤ì($$$$$%É•ÑÕÉ¸‘•±Ñ„($$$$%ô($$$%ô($$%ô($%ô($%¥˜…ÑÑ•µÁÐ€ôô…ÑÑ•µÁÑÌ´Äì($$%‰É•…¬($%ô($%Ñ¥µ•È€èôÑ¥µ”¹9•ÝQ¥µ•È¡”¹½¹Í½±•A½±±•±…ä¤($%Í•±•Ðì($%…Í”€ðµÑà¹½¹” ¤è($$%Ñ¥µ•È¹MÑ½À ¤($$%É•ÑÕÉ¸€ˆˆ($%…Í”€ðµÑ¥µ•È¹è($%ô(%ô(%É•ÑÕÉ¸€ˆˆ)ô()™Õ¹Œ½¹Í½±•Ù¥‘•¹•½µÁ±•Ñ”¡Ù•Éˆ°½ÕÑÁÕÐÍÑÉ¥¹œ¤‰½½°ì(%±½Ý•È€èôÍÑÉ¥¹Ì¹Q½1½Ý•È¡½ÕÑÁÕÐ¤(%ÍÝ¥Ñ Ù•Éˆì(%…Í”€‰±¥ÍÐˆè($%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Ñ¡•É”…É”ˆ¤€˜˜ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Á±…å•ÉÌ½¹±¥¹”ˆ¤(%…Í”€‰ÑÁÌˆè($%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰ÑÁÌˆ¤€˜˜€…ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Á±•…Í”Ý…¥Ðˆ¤(%…Í”€‰Ù•ÉÍ¥½¸ˆè($%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Ñ¡¥ÌÍ•ÉÙ•È¥ÌÉÕ¹¹¥¹œˆ¤ñð($$%ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Í•ÉÙ•ÈÙ•ÉÍ¥½¸ˆ¤ñð($$%ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Á…Á•ÈÙ•ÉÍ¥½¸ˆ¤ñð($$%ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰µ¥¹•É…™ÐÙ•ÉÍ¥½¸ˆ¤(%…Í”€‰Á±Õ¥¹Ìˆ°€‰Á°ˆè($%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Í•ÉÙ•ÈÁ±Õ¥¹Ìˆ¤ñðÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Á±Õ¥¹Ì€ ˆ¤(%…Í”€‰µÍÁÐˆè($%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰µÍÁÐˆ¤ñð($$%ÍÑÉ¥¹Ì¹½¹Ñ…¥¹Ì¡±½Ý•È°€‰Í•ÉÙ•ÈÑ¥¬Ñ¥µ•Ì€¡…Ùœ½µ¥¸½µ…à¤ˆ¤(%‘•™…Õ±Ðè($%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡½ÕÑÁÕÐ¤€„ô€ˆˆ(%ô)ô()™Õ¹Œ½¹Í½±•=ÕÑÁÕÑ•±Ñ„¡‰•™½É”°…™Ñ•ÈÍÑÉ¥¹œ¤ÍÑÉ¥¹œì(%‰•™½É”€ôÍÑÉ¥¹Ì¹I•Á±…•±°¡‰•™½É”°€‰qÉq¸ˆ°€‰q¸ˆ¤(%…™Ñ•È€ôÍÑÉ¥¹Ì¹I•Á±…•±°¡…™Ñ•È°€‰qÉq¸ˆ°€‰q¸ˆ¤(%¥˜…™Ñ•È€ôô€ˆˆñð…™Ñ•È€ôô‰•™½É”ì($%É•ÑÕÉ¸€ˆˆ(%ô(%¥˜ÍÑÉ¥¹Ì¹!…ÍAÉ•™¥à¡…™Ñ•È°‰•™½É”¤ì($%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡…™Ñ•Ém±•¸¡‰•™½É”¤ét¤(%ô(%‰•™½É”€ôÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡‰•™½É”¤(%¥˜‰•™½É”€„ô€ˆˆì($%±…ÍÑ1¥¹”€èô‰•™½É”($%¥˜¥¹‘•à€èôÍÑÉ¥¹Ì¹1…ÍÑ%¹‘•à¡‰•™½É”°€‰q¸ˆ¤ì¥¹‘•à€øô€Àì($$%±…ÍÑ1¥¹”€ô‰•™½É•m¥¹‘•à¬Äét($%ô($%¥˜¥¹‘•à€èôÍÑÉ¥¹Ì¹1…ÍÑ%¹‘•à¡…™Ñ•È°±…ÍÑ1¥¹”¤ì¥¹‘•à€øô€Àì($$%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡…™Ñ•Ém¥¹‘•à­±•¸¡±…ÍÑ1¥¹”¤ét¤($%ô(%ô(%É•ÑÕÉ¸ÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡…™Ñ•È¤)ô()Ù…È½¹Í½±•9M$€ôÉ••áÀ¹5ÕÍÑ½µÁ¥±”¡qàÅ‰qmlÀ´äìýt©l€´½t©m µùu€¤()™Õ¹ŒÍ…¹¥Ñ¥é•½¹Í½±•=ÕÑÁÕÐ¡½ÕÑÁÕÐÍÑÉ¥¹œ¤ÍÑÉ¥¹œì(%½ÕÑÁÕÐ€ô½¹Í½±•9M$¹I•Á±…•±±MÑÉ¥¹œ¡½ÕÑÁÕÐ°€ˆˆ¤(%½ÕÑÁÕÐ€ôÍ•¹Í¥Ñ¥Ù•¥…¹½ÍÑ¥Œ¹I•Á±…•±±MÑÉ¥¹œ¡½ÕÑÁÕÐ°€ˆÄõmIQtˆ¤(%½ÕÑÁÕÐ€ôÍÑÉ¥¹Ì¹5…À¡™Õ¹Œ¡ÈÉÕ¹”¤ÉÕ¹”ì($%¥˜È€ôô€q¸œñðÈ€ôô€qÐœñð€…Õ¹¥½‘”¹%Í½¹ÑÉ½°¡È¤ì($$%É•ÑÕÉ¸È($%ô($%É•ÑÕÉ¸€´Ä(%ô°½ÕÑÁÕÐ¤(%½ÕÑÁÕÐ€ôÍÑÉ¥¹Ì¹QÉ¥µMÁ…”¡½ÕÑÁÕÐ¤(%¥˜±•¸¡½ÕÑÁÕÐ¤€ø€à¨ÄÀÈÐì($%½ÕÑÁÕÐ€ô½ÕÑÁÕÑm±•¸¡½ÕÑÁÕÐ¤´à¨ÄÀÈÐét(%ô(%É•ÑÕÉ¸½ÕÑÁÕÐ)ô(