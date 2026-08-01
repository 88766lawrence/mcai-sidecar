package mcsmanager

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/mcai/sidecar-agent/internal/provider"
)

type Client struct {
	baseURL   *url.URL
	apiKey    string
	daemonIDs []string
	http      *http.Client
}

type instanceDetail struct {
	InstanceUUID string `json:"instanceUuid"`
	Status       int    `json:"status"`
	Config       struct {
		Nickname     string `json:"nickname"`
		StartCommand string `json:"startCommand"`
		Type         string `json:"type"`
	} `json:"config"`
	Info struct {
		Version string `json:"version"`
	} `json:"info"`
}

type apiResponse[T any] struct {
	Status int   `json:"status"`
	Data   T     `json:"data"`
	Time   int64 `json:"time"`
}

func New(endpoint, apiKey string, daemonIDs []string) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) {
		return nil, errors.New("provider endpoint must use HTTPS (HTTP is allowed only for localhost)")
	}
	return &Client{baseURL: u, apiKey: apiKey, daemonIDs: daemonIDs, http: &http.Client{Timeout: 20 * time.Second}}, nil
}

func (c *Client) ListInstances(ctx context.Context) ([]provider.Instance, error) {
	var result []provider.Instance
	for _, daemonID := range c.daemonIDs {
		var response apiResponse[struct {
			Data []instanceDetail `json:"data"`
		}]
		if err := c.call(ctx, http.MethodGet, "/api/service/remote_service_instances", url.Values{
			"daemonId": {daemonID}, "page": {"1"}, "page_size": {"100"}, "instance_name": {""}, "status": {""},
		}, nil, &response); err != nil {
			return nil, fmt.Errorf("list daemon %s: %w", daemonID, err)
		}
		for _, item := range response.Data.Data {
			result = append(result, profile(daemonID, item))
		}
	}
	return result, nil
}

func (c *Client) GetInstance(ctx context.Context, ref string) (provider.Instance, error) {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return provider.Instance{}, err
	}
	var response apiResponse[instanceDetail]
	if err := c.call(ctx, http.MethodGet, "/api/instance", url.Values{"daemonId": {daemonID}, "uuid": {uuid}}, nil, &response); err != nil {
		return provider.Instance{}, err
	}
	return profile(daemonID, response.Data), nil
}

func (c *Client) ReadOutput(ctx context.Context, ref string, sizeKB int) (string, error) {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return "", err
	}
	if sizeKB < 1 {
		sizeKB = 64
	}
	if sizeKB > 2048 {
		sizeKB = 2048
	}
	var response apiResponse[string]
	err = c.call(ctx, http.MethodGet, "/api/protected_instance/outputlog", url.Values{"daemonId": {daemonID}, "uuid": {uuid}, "size": {fmt.Sprint(sizeKB)}}, nil, &response)
	return response.Data, err
}

func (c *Client) ListFiles(ctx context.Context, ref, target string) (string, error) {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return "", err
	}
	var response apiResponse[struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
		Total int `json:"total"`
	}]
	err = c.call(ctx, http.MethodGet, "/api/files/list", url.Values{
		"daemonId":  {daemonID},
		"uuid":      {uuid},
		"page":      {"0"},
		"page_size": {"200"},
		"file_name": {""},
		"target":    {target},
	}, nil, &response)
	if err != nil {
		return "", err
	}
	names := make([]string, 0, len(response.Data.Items))
	for _, item := range response.Data.Items {
		if item.Name != "" {
			names = append(names, item.Name)
		}
	}
	return fmt.Sprintf("共 %d 项：%s", response.Data.Total, strings.Join(names, "、")), nil
}

func (c *Client) DownloadFromURL(ctx context.Context, ref, sourceURL, fileName string) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	// MCSManager appends file_name to the currently selected directory. The
	// executor validates the absolute destination before this boundary.
	fileName = strings.TrimPrefix(fileName, "/")
	if fileName == "" || strings.Contains(fileName, "/") {
		return errors.New("download filename must be a single file in the instance root")
	}
	var response apiResponse[any]
	return c.call(ctx, http.MethodPost, "/api/files/download_from_url", url.Values{"daemonId": {daemonID}, "uuid": {uuid}}, map[string]string{
		"url":       sourceURL,
		"file_name": fileName,
	}, &response)
}

func (c *Client) UploadFile(ctx context.Context, ref, uploadDir, fileName string, contents []byte) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	uploadDir = strings.Trim(strings.ReplaceAll(uploadDir, "\\", "/"), "/")
	if uploadDir == "" || strings.Contains(uploadDir, "..") || strings.ContainsAny(uploadDir, "\x00\r\n") {
		return errors.New("upload directory must be a safe instance-relative directory")
	}
	if path.Base(fileName) != fileName || !strings.HasSuffix(strings.ToLower(fileName), ".jar") || len(fileName) > 160 {
		return errors.New("upload filename must be a single JAR filename")
	}
	if len(contents) < 1 || len(contents) > 64<<20 {
		return errors.New("upload must contain between 1 byte and 64 MiB")
	}
	var passport apiResponse[struct {
		Password string `json:"password"`
		Addr     string `json:"addr"`
	}]
	if err := c.call(ctx, http.MethodGet, "/api/files/upload", url.Values{
		"daemonId": {daemonID}, "uuid": {uuid}, "upload_dir": {uploadDir},
	}, nil, &passport); err != nil {
		return fmt.Errorf("register upload passport: %w", err)
	}
	if passport.Data.Password == "" || passport.Data.Addr == "" {
		return errors.New("panel returned an incomplete upload passport")
	}
	daemonBase := strings.TrimSpace(passport.Data.Addr)
	if !strings.Contains(daemonBase, "://") {
		daemonBase = c.baseURL.Scheme + "://" + daemonBase
	}
	daemonBase = strings.Replace(daemonBase, "ws://", "http://", 1)
	daemonBase = strings.Replace(daemonBase, "wss://", "https://", 1)
	uploadURL, err := url.Parse(strings.TrimRight(daemonBase, "/") + "/upload/" + url.PathEscape(passport.Data.Password) + "?overwrite=true")
	if err != nil || (uploadURL.Scheme != "http" && uploadURL.Scheme != "https") {
		return errors.New("panel returned an invalid daemon upload address")
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		return err
	}
	if _, err := part.Write(contents); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL.String(), &body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := (&http.Client{Timeout: 2 * time.Minute}).Do(request)
	if err != nil {
		return fmt.Errorf("upload plugin to daemon: %w", err)
	}
	defer response.Body.Close()
	result, readErr := io.ReadAll(io.LimitReader(response.Body, 8<<10))
	if readErr != nil {
		return readErr
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || strings.TrimSpace(string(result)) != "OK" {
		return fmt.Errorf("daemon upload failed with HTTP %d", response.StatusCode)
	}
	return nil
}

func (c *Client) DeleteFiles(ctx context.Context, ref string, targets []string) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	if len(targets) == 0 || len(targets) > 16 {
		return errors.New("delete requires 1-16 explicit targets")
	}
	for _, target := range targets {
		clean := strings.TrimPrefix(strings.ReplaceAll(target, "\\", "/"), "/")
		if clean == "" || strings.Contains(clean, "..") || strings.ContainsAny(clean, "\x00\r\n") {
			return errors.New("delete target is not a safe instance-relative path")
		}
	}
	var response apiResponse[any]
	return c.call(ctx, http.MethodDelete, "/api/files/", url.Values{"daemonId": {daemonID}, "uuid": {uuid}}, map[string]any{"targets": targets}, &response)
}

func (c *Client) UpdateStartConfig(ctx context.Context, ref string, config provider.StartConfig) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	if strings.TrimSpace(config.StartCommand) == "" {
		return errors.New("start command must not be empty")
	}
	if config.StopTimeout < 0 || config.StopTimeout > 86_400 {
		return errors.New("stop timeout must be between 0 and 86400 seconds")
	}
	var response apiResponse[any]
	return c.call(ctx, http.MethodPut, "/api/instance", url.Values{"daemonId": {daemonID}, "uuid": {uuid}}, map[string]any{
		"startCommand": config.StartCommand,
		"stopCommand":  config.StopCommand,
		"stopTimeout":  config.StopTimeout,
	}, &response)
}

func (c *Client) ReadFile(ctx context.Context, ref, target string) ([]byte, error) {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return nil, err
	}
	var response apiResponse[string]
	err = c.call(ctx, http.MethodPut, "/api/files/", url.Values{"daemonId": {daemonID}, "uuid": {uuid}}, map[string]string{"target": target}, &response)
	return []byte(response.Data), err
}

func (c *Client) WriteFile(ctx context.Context, ref, target string, contents []byte) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	var response apiResponse[bool]
	return c.call(ctx, http.MethodPut, "/api/files/", url.Values{"daemonId": {daemonID}, "uuid": {uuid}}, map[string]string{"target": target, "text": string(contents)}, &response)
}

func (c *Client) SendCommand(ctx context.Context, ref, command string) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	command = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(command), "/"))
	if command == "" {
		return errors.New("console command must not be empty")
	}
	var response apiResponse[any]
	return c.call(ctx, http.MethodPost, "/api/protected_instance/command", url.Values{
		"daemonId": {daemonID},
		"uuid":     {uuid},
		"command":  {command},
	}, nil, &response)
}

func (c *Client) Restart(ctx context.Context, ref string) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	var response apiResponse[map[string]any]
	return c.call(ctx, http.MethodGet, "/api/protected_instance/restart", url.Values{"daemonId": {daemonID}, "uuid": {uuid}}, nil, &response)
}

func (c *Client) Start(ctx context.Context, ref string) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	var response apiResponse[map[string]any]
	return c.call(ctx, http.MethodGet, "/api/protected_instance/open", url.Values{"daemonId": {daemonID}, "uuid": {uuid}}, nil, &response)
}

func (c *Client) Stop(ctx context.Context, ref string) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	var response apiResponse[map[string]any]
	return c.call(ctx, http.MethodGet, "/api/protected_instance/stop", url.Values{"daemonId": {daemonID}, "uuid": {uuid}}, nil, &response)
}

func (c *Client) call(ctx context.Context, method, endpoint string, query url.Values, body any, output any) error {
	u := c.baseURL.ResolveReference(&url.URL{Path: endpoint})
	query.Set("apikey", c.apiKey)
	u.RawQuery = query.Encode()
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, 8<<20)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("panel returned HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("read panel response: %w", err)
	}
	var status struct {
		Status int `json:"status"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return fmt.Errorf("decode panel status: %w", err)
	}
	if status.Status != 200 {
		return fmt.Errorf("panel returned application status %d", status.Status)
	}
	if err := json.Unmarshal(raw, output); err != nil {
		return fmt.Errorf("decode panel response: %w", err)
	}
	return nil
}

func profile(daemonID string, detail instanceDetail) provider.Instance {
	// Process state changes as part of a normal start/stop operation. It must
	// not invalidate a plan that was approved against the same instance config.
	revision := struct {
		InstanceUUID string `json:"instanceUuid"`
		Config       any    `json:"config"`
		Info         any    `json:"info"`
	}{
		InstanceUUID: detail.InstanceUUID,
		Config:       detail.Config,
		Info:         detail.Info,
	}
	raw, _ := json.Marshal(revision)
	hash := sha256.Sum256(raw)
	loader := inferLoader(detail.Config.Type + " " + detail.Config.StartCommand)
	return provider.Instance{
		Ref: "mcs:" + daemonID + ":" + detail.InstanceUUID, Name: detail.Config.Nickname,
		Platform: loader, Loader: loader, MinecraftVersion: detail.Info.Version,
		State: stateName(detail.Status), ProfileRevision: hex.EncodeToString(hash[:]),
		ProviderType: "mcsmanager", CollectedAt: time.Now().UTC().Format(time.RFC3339),
	}
}

func parseRef(ref string) (string, string, error) {
	parts := strings.Split(ref, ":")
	if len(parts) != 3 || parts[0] != "mcs" || parts[1] == "" || parts[2] == "" {
		return "", "", errors.New("invalid MCSManager instance reference")
	}
	return parts[1], parts[2], nil
}

func stateName(status int) string {
	switch status {
	case 0:
		return "stopped"
	case 2:
		return "starting"
	case 3:
		return "running"
	default:
		return "unknown"
	}
}
func inferLoader(command string) string {
	lower := strings.ToLower(command)
	for _, loader := range []string{"paper", "fabric", "forge", "velocity", "purpur"} {
		if strings.Contains(lower, loader) {
			return loader
		}
	}
	return "unknown"
}
