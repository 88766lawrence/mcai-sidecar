package executor

import (
	"bufio"
	"bytes"
	"fmt"
	"strings"
)

func patchProperties(input []byte, key string, value any) ([]byte, error) {
	if key == "" || strings.ContainsAny(key, "\r\n=") { return nil, fmt.Errorf("invalid properties key") }
	replacement := fmt.Sprint(value)
	if strings.ContainsAny(replacement, "\r\n") { return nil, fmt.Errorf("invalid properties value") }
	scanner := bufio.NewScanner(bytes.NewReader(input))
	lines := make([]string, 0)
	found := false
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "!") {
			separator := strings.IndexAny(line, "=:")
			if separator >= 0 && strings.TrimSpace(line[:separator]) == key {
				line = key + "=" + replacement
				found = true
			}
		}
		lines = append(lines, line)
	}
	if err := scanner.Err(); err != nil { return nil, err }
	if !found { lines = append(lines, key+"="+replacement) }
	return []byte(strings.Join(lines, "\n") + "\n"), nil
}

