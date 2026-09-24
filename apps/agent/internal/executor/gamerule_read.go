package executor

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var gameruleValue = `[A-Za-z0-9_.+-]{1,128}`

func parseGameruleReadResult(rule, output string) (string, error) {
	if !regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,63}$`).MatchString(rule) {
		return "", errors.New("invalid gamerule name")
	}
	escaped := regexp.QuoteMeta(rule)
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)Gamerule\s+` + escaped + `\s+is\s+currently\s+set\s+to:\s*(` + gameruleValue + `)`),
		regexp.MustCompile(`(?i)value\s+of\s+gamerule\s+` + escaped + `\s+(?:is|=)\s*(` + gameruleValue + `)`),
		regexp.MustCompile(`(?i)` + escaped + `\s+(?:is|=)\s*(` + gameruleValue + `)`),
	}
	values := map[string]string{}
	for _, raw := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		for _, pattern := range patterns {
			if match := pattern.FindStringSubmatch(line); len(match) == 2 {
				value := strings.TrimSpace(match[1])
				if regexp.MustCompile(`(?i)^(?:currently|set|to|is)$`).MatchString(value) {
					continue
				}
				values[strings.ToLower(value)] = value
				break
			}
		}
	}
	if len(values) != 1 {
		return "", errors.New("gamerule callback is missing, truncated, or conflicting")
	}
	for _, value := range values {
		return value, nil
	}
	return "", fmt.Errorf("gamerule %s did not return a value", rule)
}
