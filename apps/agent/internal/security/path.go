package security

import (
	"errors"
	"path"
	"strings"
)

var allowedExtensions = map[string]bool{
	".yml": true, ".yaml": true, ".json": true, ".properties": true,
	".toml": true, ".conf": true, ".jar": true,
}

func NormalizeRelative(input string) (string, error) {
	if input == "" || strings.ContainsRune(input, '\x00') { return "", errors.New("empty or invalid path") }
	normalized := strings.ReplaceAll(input, "\\", "/")
	if strings.HasPrefix(normalized, "/") || strings.Contains(normalized, ":") { return "", errors.New("absolute paths are forbidden") }
	clean := path.Clean(normalized)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") { return "", errors.New("path escapes the instance root") }
	ext := strings.ToLower(path.Ext(clean))
	if !allowedExtensions[ext] { return "", errors.New("file extension is not allowed") }
	return "/" + clean, nil
}

