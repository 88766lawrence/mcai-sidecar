package executor

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

func patchConfiguration(input []byte, target, key string, value any) ([]byte, error) {
	if key == "" || len(key) > 240 || strings.ContainsAny(key, "\r\n") {
		return nil, errors.New("invalid configuration key path")
	}
	switch strings.ToLower(filepath.Ext(target)) {
	case ".properties", ".conf":
		return patchProperties(input, key, value)
	case ".yml", ".yaml":
		return patchYAML(input, key, value)
	case ".json":
		return patchJSON(input, key, value)
	default:
		return nil, errors.New("configuration format is not supported for structured patches")
	}
}

func patchYAML(input []byte, key string, value any) ([]byte, error) {
	var document yaml.Node
	if err := decodeYAMLDocument(input, &document); err != nil {
		return nil, fmt.Errorf("parse YAML configuration: %w", err)
	}
	if len(document.Content) == 0 {
		if document.Kind == 0 {
			document.Kind = yaml.DocumentNode
		}
		document.Content = append(document.Content, &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"})
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, errors.New("YAML configuration root must be a mapping")
	}
	parts, err := configurationPath(key)
	if err != nil {
		return nil, err
	}
	current := root
	for _, part := range parts[:len(parts)-1] {
		next := yamlMappingValue(current, part)
		if next == nil {
			keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: part}
			next = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			current.Content = append(current.Content, keyNode, next)
		}
		if next.Kind != yaml.MappingNode {
			return nil, fmt.Errorf("YAML key path %q crosses a non-mapping value", part)
		}
		current = next
	}
	encodedValue := &yaml.Node{}
	if err := encodedValue.Encode(value); err != nil {
		return nil, fmt.Errorf("encode YAML value: %w", err)
	}
	setYAMLMappingValue(current, parts[len(parts)-1], encodedValue)
	var output bytes.Buffer
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return nil, fmt.Errorf("encode YAML configuration: %w", err)
	}
	_ = encoder.Close()
	return output.Bytes(), nil
}

func decodeYAMLDocument(input []byte, document any) error {
	decoder := yaml.NewDecoder(bytes.NewReader(input))
	if err := decoder.Decode(document); err != nil {
		if err == io.EOF {
			return nil
		}
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("YAML configuration contains multiple documents")
		}
		return fmt.Errorf("YAML configuration has trailing content: %w", err)
	}
	return nil
}

func yamlMappingValue(mapping *yaml.Node, key string) *yaml.Node {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key {
			return mapping.Content[index+1]
		}
	}
	return nil
}

func setYAMLMappingValue(mapping *yaml.Node, key string, value *yaml.Node) {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key {
			mapping.Content[index+1] = value
			return
		}
	}
	mapping.Content = append(mapping.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value,
	)
}

func patchJSON(input []byte, key string, value any) ([]byte, error) {
	root, err := decodeJSONObject(input)
	if err != nil {
		return nil, fmt.Errorf("parse JSON configuration: %w", err)
	}
	parts, err := configurationPath(key)
	if err != nil {
		return nil, err
	}
	current := root
	for _, part := range parts[:len(parts)-1] {
		next, exists := current[part]
		if !exists {
			child := map[string]any{}
			current[part] = child
			current = child
			continue
		}
		child, ok := next.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("JSON key path %q crosses a non-object value", part)
		}
		current = child
	}
	current[parts[len(parts)-1]] = value
	output, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode JSON configuration: %w", err)
	}
	return append(output, '\n'), nil
}

func decodeJSONObject(input []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	var root map[string]any
	if err := decoder.Decode(&root); err != nil {
		return nil, err
	}
	if root == nil {
		return nil, errors.New("JSON configuration root must be an object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return nil, errors.New("JSON configuration contains multiple values")
		}
		return nil, fmt.Errorf("JSON configuration has trailing content: %w", err)
	}
	return root, nil
}

func configurationPath(key string) ([]string, error) {
	parts := strings.Split(key, ".")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 100 {
			return nil, errors.New("invalid configuration key path")
		}
	}
	return parts, nil
}
