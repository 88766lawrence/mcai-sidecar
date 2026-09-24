package executor

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode/utf8"
)

type ConsoleCommandOutcome struct {
	SchemaVersion string `json:"schema_version"`
	Status        string `json:"status"`
	Code          string `json:"code"`
	UserMessage   string `json:"user_message"`
	OutputSHA256  string `json:"output_sha256"`
}

func ClassifyConsoleCommandOutcome(output string, strict ...bool) ConsoleCommandOutcome {
	return ClassifyConsoleCommandOutcomeForCommand("", output, strict...)
}

func ClassifyConsoleCommandOutcomeForCommand(command, output string, strict ...bool) ConsoleCommandOutcome {
	digest := sha256.Sum256([]byte(output))
	base := ConsoleCommandOutcome{SchemaVersion: generatedConsoleOutcomeSchema, OutputSHA256: hex.EncodeToString(digest[:])}
	normalized := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(output), "控制台返回：")))
	if normalized == "" {
		base.Status = "indeterminate"
		base.Code = "EMPTY_CALLBACK"
		base.UserMessage = "服务器没有返回可判断的命令结果，因此无法确认这次操作是否生效。"
		return base
	}
	requireExplicit := len(strict) > 0 && strict[0]
	if !utf8.ValidString(normalized) || strings.ContainsRune(normalized, utf8.RuneError) || (requireExplicit && utf8.RuneCountInString(normalized) < generatedConsoleMinimumVisibleRunes) {
		base.Status = "indeterminate"
		base.Code = "INCOMPLETE_CALLBACK"
		base.UserMessage = generatedConsoleIncompleteMessage
		return base
	}
	normalizedCommand := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(command), "/")))
	guardedAudience, _ := regexp.MatchString(`^execute\s+if\s+entity\s+@a\s+run\s+execute\s+as\s+@a\b`, normalizedCommand)
	failedCondition, _ := regexp.MatchString(`(?i)^(?:test failed|conditional check failed)[.!]?$`, normalized)
	if requireExplicit && guardedAudience && failedCondition {
		base.Status = "rejected"
		base.Code = "NO_TARGETS"
		base.UserMessage = "没有找到符合条件的目标，因此没有对象收到或应用这次操作。"
		return base
	}
	for _, failure := range generatedConsoleOutcomeFailurePatterns {
		matched, err := regexp.MatchString(failure.pattern, normalized)
		if err == nil && matched {
			base.Status = "rejected"
			base.Code = failure.code
			base.UserMessage = failure.userMessage
			return base
		}
	}
	for _, pattern := range generatedConsoleOutcomeSuccessPatterns {
		matched, err := regexp.MatchString(pattern, normalized)
		if err == nil && matched {
			base.Status = "applied"
			base.Code = "EXPLICIT_SUCCESS"
			base.UserMessage = "服务器返回了明确的成功结果。"
			return base
		}
	}
	for _, pattern := range generatedConsoleOutcomeAcceptedPatterns {
		matched, err := regexp.MatchString(pattern, normalized)
		if err == nil && matched {
			base.Status = "accepted_unverified"
			base.Code = "CALLBACK_ACCEPTED"
			base.UserMessage = "服务器明确接受了命令，但没有可用的独立效果复核。"
			return base
		}
	}
	if requireExplicit {
		base.Status = "indeterminate"
		base.Code = "INCOMPLETE_CALLBACK"
		base.UserMessage = generatedConsoleIncompleteMessage
		return base
	}
	base.Status = "accepted_unverified"
	base.Code = "CALLBACK_ACCEPTED"
	base.UserMessage = "服务器返回了命令结果，但没有可用的独立效果复核。"
	return base
}
