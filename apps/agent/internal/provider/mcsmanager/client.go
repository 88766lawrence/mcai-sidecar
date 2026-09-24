package mcsmanager

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
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
		LastDatetime int64  `json:"lastDatetime"`
		Type         string `json:"type"`
		Docker       struct {
			Memory int64 `json:"memory"`
		} `json:"docker"`
	} `json:"config"`
	Info struct {
		Version string `json:"version"`
	} `json:"info"`
	ProcessInfo struct {
		Memory int64   `json:"memory"`
		CPU    float64 `json:"cpu"`
	} `json:"processInfo"`
}

type apiResponse[T any] struct {
	Status int   `json:"status"`
	Data   T     `json:"data"`
	Time   int64 `json:"time"`
}

var minecraftVersionPattern = regexp.MustCompile(`(?i)(?:minecraft(?:\s+server)?\s+version|implementing\s+api\s+version|\bmc\s*[:=])[^0-9]{0,32}(1\.\d+(?:\.\d+)?)|\b(?:paper|purpur|fabric|forge|spigot)[^\r\n]{0,64}?\b(1\.\d+(?:\.\d+)?)\b`)
var plainMinecraftVersionPattern = regexp.MustCompile(`^1\.\d+(?:\.\d+)?$`)

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
			result = append(result, c.enrichProfile(ctx, profile(daemonID, item)))
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
	return c.enrichProfile(ctx, profile(daemonID, response.Data)), nil
}

// enrichProfile turns runtime evidence into shared inventory facts. MCSManager
// frequently reports a universal process with an empty version, even though
// the console and server files identify the implementation precisely. Keeping
// this at the provider boundary means every task receives the same facts,
// instead of rediscovering them inside one specific executor workflow.
func (c *Client) enrichProfile(ctx context.Context, instance provider.Instance) provider.Instance {
	loader := strings.ToLower(strings.TrimSpace(instance.Loader))
	version := strings.TrimSpace(instance.MinecraftVersion)
	if loader != "" && loader != "unknown" && plainMinecraftVersionPattern.MatchString(version) {
		return instance
	}

	var evidence strings.Builder
	if output, err := c.ReadOutput(ctx, instance.Ref, 256); err == nil {
		evidence.WriteString(output)
		evidence.WriteByte('\n')
	}
	if latest, err := c.ReadFile(ctx, instance.Ref, "logs/latest.log"); err == nil {
		evidence.Write(latest)
		evidence.WriteByte('\n')
	}
	if listing, err := c.ListFiles(ctx, instance.Ref, "/"); err == nil {
		evidence.WriteString(listing)
	}
	lower := strings.ToLower(evidence.String())
	if loader == "" || loader == "unknown" {
		switch {
		case strings.Contains(lower, "purpur"):
			loader = "purpur"
		case strings.Contains(lower, "paper") || strings.Contains(lower, "paper-global.yml"):
			loader = "paper"
		case strings.Contains(lower, "fabric") || strings.Contains(lower, "fabric-server-launcher.properties"):
			loader = "fabric"
		case strings.Contains(lower, "forge") || strings.Contains(lower, "neoforge"):
			loader = "forge"
		case strings.Contains(lower, "spigot.yml") || strings.Contains(lower, "bukkit.yml"):
			loader = "spigot"
		}
	}
	if !plainMinecraftVersionPattern.MatchString(version) {
		if match := minecraftVersionPattern.FindStringSubmatch(evidence.String()); len(match) > 0 {
			for _, candidate := range match[1:] {
				if candidate != "" {
					version = candidate
					break
				}
			}
		}
	}
	if loader != "" && loader != "unknown" {
		instance.Loader = loader
		instance.Platform = loader
	}
	if plainMinecraftVersionPattern.MatchString(version) {
		instance.MinecraftVersion = version
	}
	return instance
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
	listing, err := c.ListFileEntries(ctx, ref, target)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("共 %d 项：%s", listing.Total, strings.Join(listing.Names, "、")), nil
}

func (c *Client) ListFileEntries(ctx context.Context, ref, target string) (provider.FileListing, error) {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return provider.FileListing{}, err
	}
	names, total, err := c.listFiles(ctx, daemonID, uuid, target)
	if err != nil {
		// MCSManager returns HTTP 500 for a directory that does not exist.
		// Distinguish that state from a provider failure by listing the direct
		// parent: an absent child is an authoritative empty collection, while an
		// existing child with a failing list keeps the original error.
		clean := path.Clean("/" + strings.TrimPrefix(strings.ReplaceAll(target, "\\", "/"), "/"))
		parent, base := path.Dir(clean), path.Base(clean)
		if clean != "/" && parent != clean && base != "." && base != "/" {
			parentNames, _, parentErr := c.listFiles(ctx, daemonID, uuid, parent)
			if parentErr == nil && !containsExactName(parentNames, base) {
				return provider.FileListing{Names: []string{}, Total: 0}, nil
			}
		}
		return provider.FileListing{}, err
	}
	return provider.FileListing{Names: names, Total: total, Truncated: total > len(names)}, nil
}

func (c *Client) listFiles(ctx context.Context, daemonID, uuid, target string) ([]string, int, error) {
	var response apiResponse[struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
		Total int `json:"total"`
	}]
	err := c.call(ctx, http.MethodGet, "/api/files/list", url.Values{
		"daemonId":  {daemonID},
		"uuid":      {uuid},
		"page":      {"0"},
		"page_size": {"200"},
		"file_name": {""},
		"target":    {target},
	}, nil, &response)
	if err != nil {
		return nil, 0, err
	}
	names := make([]string, 0, len(response.Data.Items))
	for _, item := range response.Data.Items {
		if item.Name != "" {
			names = append(names, item.Name)
		}
	}
	return names, response.Data.Total, nil
}

func containsExactName(names []string, expected string) bool {
	for _, name := range names {
		if name == expected {
			return true
		}
	}
	return false
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

// CreateBinaryFile commits one exact new file without replacing an existing
// target. Bytes are uploaded under a random, proven-absent staging name,
// read back byte-for-byte, then moved to the final path with MCSManager's
// non-overwriting move operation.
func (c *Client) CreateBinaryFile(ctx context.Context, ref, target string, contents []byte) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	target, err = canonicalBinaryCreateTarget(target)
	if err != nil {
		return err
	}
	if len(contents) < 1 || len(contents) > 64<<20 {
		return errors.New("binary create must contain between 1 byte and 64 MiB")
	}
	parent, finalName := path.Dir(target), path.Base(target)
	if parent == "." {
		parent = "/"
	}
	if parent != "/" {
		if strings.Contains(parent, "/") {
			return errors.New("binary create supports one inert staging directory level")
		}
		root, err := c.ListFileEntries(ctx, ref, "/")
		if err != nil || root.Truncated {
			return errors.New("cannot prove the binary staging directory state")
		}
		if !containsExactName(root.Names, parent) {
			var response apiResponse[any]
			if err := c.call(ctx, http.MethodPost, "/api/files/mkdir", url.Values{
				"daemonId": {daemonID}, "uuid": {uuid},
			}, map[string]string{"target": "/" + parent}, &response); err != nil {
				if _, listErr := c.ListFileEntries(ctx, ref, parent); listErr != nil {
					return fmt.Errorf("create binary staging directory: %w", err)
				}
			}
		}
	}
	listing, err := c.ListFileEntries(ctx, ref, parent)
	if err != nil || listing.Truncated {
		return errors.New("cannot prove the binary target is absent")
	}
	if containsExactName(listing.Names, finalName) {
		return errors.New("binary create target already exists")
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return errors.New("generate binary create staging name")
	}
	stagingName := ".mcai-download-" + hex.EncodeToString(random) + ".part"
	if containsExactName(listing.Names, stagingName) {
		return errors.New("binary create staging target collision")
	}
	stagingTarget := stagingName
	if parent != "/" {
		stagingTarget = path.Join(parent, stagingName)
	}
	cleanup := func() {
		_ = c.DeleteFiles(context.WithoutCancel(ctx), ref, []string{"/" + stagingTarget})
	}
	if err := c.uploadCreateBinary(ctx, ref, parent, stagingName, contents); err != nil {
		cleanup()
		return fmt.Errorf("upload binary create staging file: %w", err)
	}
	readBack, err := c.ReadBinaryFile(ctx, ref, stagingTarget)
	if err != nil {
		cleanup()
		return fmt.Errorf("verify binary create staging file: %w", err)
	}
	wantHash, gotHash := sha256.Sum256(contents), sha256.Sum256(readBack)
	if len(readBack) != len(contents) || gotHash != wantHash {
		cleanup()
		return errors.New("binary create staging bytes did not match")
	}
	var response apiResponse[any]
	if err := c.call(ctx, http.MethodPut, "/api/files/move", url.Values{
		"daemonId": {daemonID}, "uuid": {uuid},
	}, map[string]any{"targets": [][]string{{"/" + stagingTarget, "/" + target}}}, &response); err != nil {
		cleanup()
		return fmt.Errorf("commit binary create without overwrite: %w", err)
	}
	return nil
}

func canonicalBinaryCreateTarget(raw string) (string, error) {
	raw = strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	if raw == "" || strings.HasPrefix(raw, "/") || strings.HasSuffix(raw, "/") || len(raw) > 256 {
		return "", errors.New("binary create target must be one safe instance-relative file path")
	}
	clean := path.Clean(raw)
	if clean != raw || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", errors.New("binary create target must be one safe instance-relative file path")
	}
	for _, segment := range strings.Split(clean, "/") {
		if segment == "" || len(segment) > 160 || strings.TrimSpace(segment) == "" || strings.ContainsAny(segment, "<>\"|?*;:\x00\r\n") {
			return "", errors.New("binary create target must be one safe instance-relative file path")
		}
	}
	return clean, nil
}

func (c *Client) uploadCreateBinary(ctx context.Context, ref, uploadDir, fileName string, contents []byte) error {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return err
	}
	if uploadDir == "." || uploadDir == "" {
		uploadDir = "/"
	}
	if uploadDir != "/" {
		uploadDir = strings.Trim(uploadDir, "/")
	}
	if uploadDir == "" || path.Base(fileName) != fileName || fileName == "" || len(fileName) > 160 || strings.ContainsAny(fileName, "/\\<>\"|?*;:\x00\r\n") {
		return errors.New("binary staging destination is invalid")
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
	base, err := daemonTransferBaseURL(c.baseURL.Scheme, passport.Data.Addr)
	if err != nil || !validTransferPassword(passport.Data.Password) {
		return errors.New("panel returned an invalid upload passport")
	}
	uploadURL := base.ResolveReference(&url.URL{Path: "/upload/" + passport.Data.Password, RawQuery: "overwrite=false"})
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
	response, err := daemonTransferClient(2 * time.Minute).Do(request)
	if err != nil {
		return fmt.Errorf("upload staging file to daemon: %w", err)
	}
	defer response.Body.Close()
	result, readErr := io.ReadAll(io.LimitReader(response.Body, 8<<10))
	if readErr != nil {
		return readErr
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || strings.TrimSpace(string(result)) != "OK" {
		return fmt.Errorf("daemon staging upload failed with HTTP %d", response.StatusCode)
	}
	return nil
}

// ReadBinaryFile follows MCSManager's one-time download-passport protocol so
// callers can verify the exact bytes committed to the instance filesystem.
func (c *Client) ReadBinaryFile(ctx context.Context, ref, target string) ([]byte, error) {
	daemonID, uuid, err := parseRef(ref)
	if err != nil {
		return nil, err
	}
	target = strings.TrimPrefix(strings.ReplaceAll(strings.TrimSpace(target), "\\", "/"), "/")
	cleanTarget := path.Clean("/" + target)
	if target == "" || cleanTarget != "/"+target || strings.ContainsAny(target, "\x00\r\n") || len(target) > 512 {
		return nil, errors.New("binary read target must be a safe instance-relative file")
	}
	fileName := path.Base(target)
	if fileName == "." || fileName == "/" || fileName == "" || len(fileName) > 160 {
		return nil, errors.New("binary read target omitted a safe filename")
	}
	var passport apiResponse[struct {
		Password string `json:"password"`
		Addr     string `json:"addr"`
	}]
	if err := c.call(ctx, http.MethodPost, "/api/files/download", url.Values{
		"daemonId": {daemonID}, "uuid": {uuid}, "file_name": {"/" + target},
	}, nil, &passport); err != nil {
		return nil, fmt.Errorf("register download passport: %w", err)
	}
	base, err := daemonTransferBaseURL(c.baseURL.Scheme, passport.Data.Addr)
	if err != nil || !validTransferPassword(passport.Data.Password) {
		return nil, errors.New("panel returned an invalid download passport")
	}
	downloadURL := base.ResolveReference(&url.URL{Path: "/download/" + passport.Data.Password + "/" + fileName})
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL.String(), nil)
	if err != nil {
		return nil, err
	}
	response, err := daemonTransferClient(2 * time.Minute).Do(request)
	if err != nil {
		return nil, fmt.Errorf("download binary file from daemon: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 || response.ContentLength > 64<<20 {
		return nil, fmt.Errorf("daemon binary download failed with HTTP %d", response.StatusCode)
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, (64<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(contents) < 1 || len(contents) > 64<<20 {
		return nil, errors.New("daemon binary download is outside the 1 byte to 64 MiB limit")
	}
	return contents, nil
}

func validTransferPassword(password string) bool {
	return regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`).MatchString(password)
}

func daemonTransferBaseURL(defaultScheme, address string) (*url.URL, error) {
	raw := strings.TrimSpace(address)
	if !strings.Contains(raw, "://") {
		raw = defaultScheme + "://" + raw
	}
	raw = strings.Replace(raw, "ws://", "http://", 1)
	raw = strings.Replace(raw, "wss://", "https://", 1)
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("daemon transfer address is invalid")
	}
	parsed.Path, parsed.RawPath = "", ""
	return parsed, nil
}

func daemonTransferClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
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
		Config       struct {
			Nickname     string `json:"nickname"`
			StartCommand string `json:"startCommand"`
			Type         string `json:"type"`
		} `json:"config"`
		Info struct {
			Version string `json:"version"`
		} `json:"info"`
	}{
		InstanceUUID: detail.InstanceUUID,
	}
	revision.Config.Nickname = detail.Config.Nickname
	revision.Config.StartCommand = detail.Config.StartCommand
	revision.Config.Type = detail.Config.Type
	revision.Info.Version = detail.Info.Version
	raw, _ := json.Marshal(revision)
	hash := sha256.Sum256(raw)
	loader := inferLoader(detail.Config.Type + " " + detail.Config.StartCommand)
	return provider.Instance{
		Ref: "mcs:" + daemonID + ":" + detail.InstanceUUID, Name: detail.Config.Nickname,
		Platform: loader, Loader: loader, MinecraftVersion: detail.Info.Version,
		State: stateName(detail.Status), ProfileRevision: hex.EncodeToString(hash[:]),
		ProviderType: "mcsmanager", CollectedAt: time.Now().UTC().Format(time.RFC3339),
		MemoryBytes: detail.ProcessInfo.Memory, MemoryLimitBytes: instanceMemoryLimit(detail), CPUUsage: detail.ProcessInfo.CPU,
		UptimeSeconds: instanceUptimeSeconds(detail),
	}
}

func instanceUptimeSeconds(detail instanceDetail) int64 {
	if detail.Status != 3 || detail.Config.LastDatetime <= 0 {
		return 0
	}
	started := time.UnixMilli(detail.Config.LastDatetime)
	seconds := int64(time.Since(started).Seconds())
	if seconds < 0 || seconds > 10*365*24*60*60 {
		return 0
	}
	return seconds
}

var javaMaximumHeapPattern = regexp.MustCompile(`(?i)(?:^|\s)-Xmx(\d+(?:\.\d+)?)([kmgt])(?:\s|$)`)

func instanceMemoryLimit(detail instanceDetail) int64 {
	if detail.Config.Docker.Memory > 0 {
		return detail.Config.Docker.Memory
	}
	match := javaMaximumHeapPattern.FindStringSubmatch(detail.Config.StartCommand)
	if len(match) != 3 {
		return 0
	}
	value, err := strconv.ParseFloat(match[1], 64)
	if err != nil || value <= 0 {
		return 0
	}
	multiplier := map[string]float64{"k": 1 << 10, "m": 1 << 20, "g": 1 << 30, "t": 1 << 40}[strings.ToLower(match[2])]
	bytes := value * multiplier
	if bytes <= 0 || bytes > math.MaxInt64 {
		return 0
	}
	return int64(bytes)
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
