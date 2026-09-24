package executor

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path"
	"regexp"
	"strings"
	"unicode"

	"github.com/mcai/sidecar-agent/internal/provider"
	"gopkg.in/yaml.v3"
)

const readResultDigestDomain = "read-tool-result/v1\x00"

var configKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
var sensitiveConfigKey = regexp.MustCompile(`(?i)(?:password|passwd|api[-_]?key|secret|token)`)

func sealReadResult(value map[string]any) (map[string]any, error) {
	if _, exists := value["result_digest"]; exists {
		return nil, errors.New("typed read result already contains a digest")
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, fmt.Errorf("encode typed read result: %w", err)
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
	sum := sha256.Sum256(append([]byte(readResultDigestDomain), encoded...))
	value["result_digest"] = hex.EncodeToString(sum[:])
	return value, nil
}

func configInspectObservation(contents []byte, normalizedPath string, keys []string) (map[string]any, error) {
	canonicalPath, err := canonicalReadPath(normalizedPath, false)
	if err != nil {
		return nil, err
	}
	if len(keys) < 1 || len(keys) > 32 {
		return nil, errors.New("config.inspect requires one to thirty-two exact keys")
	}
	seen := map[string]bool{}
	for _, key := range keys {
		identity := strings.ToLower(key)
		if !configKeyPattern.MatchString(key) || seen[identity] {
			return nil, errors.New("config.inspect keys must be safe and unique")
		}
		seen[identity] = true
	}

	extension := strings.ToLower(path.Ext(canonicalPath))
	entries := make([]map[string]any, 0, len(keys))
	switch extension {
	case ".properties", ".conf":
		values, parseErr := parseFlatConfiguration(contents)
		if parseErr != nil {
			return nil, parseErr
		}
		for _, key := range keys {
			value, present := values[strings.ToLower(key)]
			entries = append(entries, configObservationEntry(key, present, value))
		}
	case ".yml", ".yaml", ".json":
		var document any
		if err := yaml.Unmarshal(contents, &document); err != nil {
			return nil, fmt.Errorf("parse configuration for typed inspection: %w", err)
		}
		for _, key := range keys {
			value, present := nestedConfigurationValue(document, strings.Split(key, "."))
			entries = append(entries, configObservationEntry(key, present, value))
		}
	default:
		return nil, errors.New("configuration format does not support typed key inspection")
	}

	return sealReadResult(map[string]any{
		"schema_version": "config-inspect-result/v1",
		"path":           canonicalPath,
		"entries":        entries,
	})
}

func parseFlatConfiguration(contents []byte) (map[string]string, error) {
	values := map[string]string{}
	for _, raw := range strings.Split(strings.ReplaceAll(string(contents), "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		separator := strings.IndexAny(line, "=:")
		if separator <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:separator])
		if !configKeyPattern.MatchString(key) {
			continue
		}
		identity := strings.ToLower(key)
		value := strings.TrimSpace(line[separator+1:])
		if previous, exists := values[identity]; exists && previous != value {
			return nil, fmt.Errorf("configuration contains conflicting values for %s", key)
		}
		values[identity] = value
	}
	return values, nil
}

func configObservationEntry(key string, present bool, raw any) map[string]any {
	entry := map[string]any{"key": key, "present": present}
	if !present {
		return entry
	}
	value, safe := safeConfigScalar(raw)
	if sensitiveConfigKey.MatchString(key) || !safe {
		entry["redacted"] = true
		return entry
	}
	entry["value"] = value
	return entry
}

func safeConfigScalar(value any) (any, bool) {
	if value == nil {
		return nil, true
	}
	switch typed := value.(type) {
	case string:
		if len(typed) > 4_096 || strings.IndexFunc(typed, func(r rune) bool { return r != '\t' && unicode.IsControl(r) }) >= 0 {
			return nil, false
		}
		return typed, true
	case bool:
		return typed, true
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return nil, false
		}
		var normalized any
		if json.Unmarshal(encoded, &normalized) != nil {
			return nil, false
		}
		if number, ok := normalized.(float64); ok && !math.IsInf(number, 0) && !math.IsNaN(number) {
			return number, true
		}
	}
	return nil, false
}

func filesListObservation(providerListing provider.FileListing, requestedPath, suffix string) (map[string]any, error) {
	canonicalPath, err := canonicalReadPath(requestedPath, true)
	if err != nil {
		return nil, err
	}
	if suffix != "" && !regexp.MustCompile(`^\.[A-Za-z0-9_-]{1,32}$`).MatchString(suffix) {
		return nil, errors.New("files.list suffix is invalid")
	}
	if providerListing.Truncated || providerListing.Total < 0 || providerListing.Total > 200 || providerListing.Total != len(providerListing.Names) {
		return nil, errors.New("provider file listing is incomplete or invalid")
	}
	seen := map[string]bool{}
	filtered := make([]map[string]any, 0, len(providerListing.Names))
	for _, name := range providerListing.Names {
		if name == "" || name == "." || name == ".." || len(name) > 255 || strings.ContainsAny(name, "/\\\x00\r\n") || seen[name] {
			return nil, errors.New("provider file listing contains an invalid or duplicate entry")
		}
		seen[name] = true
		if suffix == "" || strings.HasSuffix(strings.ToLower(name), strings.ToLower(suffix)) {
			filtered = append(filtered, map[string]any{"name": name})
		}
	}
	result := map[string]any{
		"schema_version": "files-list-result/v1", "path": canonicalPath,
		"entries": filtered, "total": providerListing.Total,
		"filtered_count": len(filtered), "truncated": false,
	}
	if suffix != "" {
		result["suffix"] = suffix
	}
	return sealReadResult(result)
}

func canonicalReadPath(input string, allowRoot bool) (string, error) {
	if input == "" || len(input) > 256 || strings.ContainsAny(input, "\\:\x00\r\n") || strings.HasPrefix(input, "//") {
		return "", errors.New("read path is invalid")
	}
	trimmed := strings.TrimPrefix(input, "/")
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == ".." {
			return "", errors.New("read path escapes the instance root")
		}
	}
	clean := path.Clean(trimmed)
	if clean == "." {
		if allowRoot {
			return ".", nil
		}
		return "", errors.New("read path must identify one file")
	}
	if strings.HasPrefix(clean, "../") || clean == ".." {
		return "", errors.New("read path escapes the instance root")
	}
	return clean, nil
}
