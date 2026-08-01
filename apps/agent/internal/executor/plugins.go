package executor

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

const modrinthAPI = "https://api.modrinth.com/v2"

var pluginProjectPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,63}$`)

type resolvedPlugin struct {
	Project       string
	VersionID     string
	VersionNumber string
	FileName      string
	SourceURL     string
	SourceSHA512  string
	LocalSHA256   string
	Contents      []byte
}

type pluginResolver interface {
	Resolve(context.Context, string, string, string) (resolvedPlugin, error)
}

type officialPluginResolver struct {
	httpClient *http.Client
	apiBase    string
}

func newOfficialPluginResolver() *officialPluginResolver {
	return &officialPluginResolver{httpClient: &http.Client{Timeout: 45 * time.Second}, apiBase: modrinthAPI}
}

func (r *officialPluginResolver) Resolve(ctx context.Context, project, loader, minecraftVersion string) (resolvedPlugin, error) {
	project = strings.ToLower(strings.TrimSpace(project))
	loader = strings.ToLower(strings.TrimSpace(loader))
	if !pluginProjectPattern.MatchString(project) {
		return resolvedPlugin{}, errors.New("plugin project must be a Modrinth slug or project ID")
	}
	if !minecraftVersionPattern.MatchString(minecraftVersion) {
		return resolvedPlugin{}, errors.New("plugin resolution requires a valid Minecraft version")
	}
	if loader == "purpur" || loader == "spigot" || loader == "bukkit" {
		loader = "paper"
	}
	if loader != "paper" {
		return resolvedPlugin{}, fmt.Errorf("plugin workflow currently supports Paper-compatible servers; got %q", loader)
	}
	loaders, _ := json.Marshal([]string{loader})
	gameVersions, _ := json.Marshal([]string{minecraftVersion})
	endpoint := strings.TrimRight(r.apiBase, "/") + "/project/" + url.PathEscape(project) + "/version?loaders=" + url.QueryEscape(string(loaders)) + "&game_versions=" + url.QueryEscape(string(gameVersions))
	var versions []struct {
		ID            string `json:"id"`
		VersionNumber string `json:"version_number"`
		Dependencies  []struct {
			ProjectID      string `json:"project_id"`
			DependencyType string `json:"dependency_type"`
		} `json:"dependencies"`
		Files []struct {
			URL      string `json:"url"`
			Filename string `json:"filename"`
			Primary  bool   `json:"primary"`
			Hashes   struct {
				SHA512 string `json:"sha512"`
			} `json:"hashes"`
		} `json:"files"`
	}
	if err := r.getJSON(ctx, endpoint, &versions); err != nil {
		return resolvedPlugin{}, fmt.Errorf("resolve Modrinth project %s: %w", project, err)
	}
	if len(versions) == 0 {
		return resolvedPlugin{}, fmt.Errorf("Modrinth has no %s version compatible with %s", project, minecraftVersion)
	}
	version := versions[0]
	for _, dependency := range version.Dependencies {
		if dependency.DependencyType == "required" && dependency.ProjectID != "" {
			return resolvedPlugin{}, fmt.Errorf("plugin requires dependency %s; dependency installation must be approved first", dependency.ProjectID)
		}
	}
	if version.ID == "" || version.VersionNumber == "" {
		return resolvedPlugin{}, errors.New("Modrinth returned incomplete version metadata")
	}
	var selected *struct {
		URL      string `json:"url"`
		Filename string `json:"filename"`
		Primary  bool   `json:"primary"`
		Hashes   struct {
			SHA512 string `json:"sha512"`
		} `json:"hashes"`
	}
	for index := range version.Files {
		candidate := &version.Files[index]
		if strings.HasSuffix(strings.ToLower(candidate.Filename), ".jar") && (selected == nil || candidate.Primary) {
			selected = candidate
			if candidate.Primary {
				break
			}
		}
	}
	if selected == nil || filepath.Base(selected.Filename) != selected.Filename || len(selected.Hashes.SHA512) != 128 {
		return resolvedPlugin{}, errors.New("Modrinth did not provide a primary JAR with a SHA-512 hash")
	}
	artifactURL, err := url.Parse(selected.URL)
	trustedOfficial := artifactURL.Scheme == "https" && artifactURL.Hostname() == "cdn.modrinth.com"
	trustedTest := r.apiBase != modrinthAPI && (artifactURL.Scheme == "http" || artifactURL.Scheme == "https")
	if err != nil || (!trustedOfficial && !trustedTest) {
		return resolvedPlugin{}, errors.New("Modrinth returned an untrusted artifact URL")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifactURL.String(), nil)
	if err != nil {
		return resolvedPlugin{}, err
	}
	request.Header.Set("User-Agent", "MCAI-Sidecar/0.1 (controlled-plugin-resolver)")
	response, err := r.httpClient.Do(request)
	if err != nil {
		return resolvedPlugin{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return resolvedPlugin{}, fmt.Errorf("Modrinth CDN returned HTTP %d", response.StatusCode)
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, (64<<20)+1))
	if err != nil {
		return resolvedPlugin{}, err
	}
	if len(contents) == 0 || len(contents) > 64<<20 {
		return resolvedPlugin{}, errors.New("plugin artifact size is outside the 1 byte to 64 MiB limit")
	}
	declared := strings.ToLower(selected.Hashes.SHA512)
	actual512 := sha512.Sum512(contents)
	if hex.EncodeToString(actual512[:]) != declared {
		return resolvedPlugin{}, errors.New("plugin artifact SHA-512 does not match Modrinth metadata")
	}
	actual256 := sha256.Sum256(contents)
	return resolvedPlugin{
		Project: project, VersionID: version.ID, VersionNumber: version.VersionNumber,
		FileName: selected.Filename, SourceURL: selected.URL, SourceSHA512: declared,
		LocalSHA256: hex.EncodeToString(actual256[:]), Contents: contents,
	}, nil
}

func (r *officialPluginResolver) getJSON(ctx context.Context, endpoint string, output any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "MCAI-Sidecar/0.1 (controlled-plugin-resolver)")
	response, err := r.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("Modrinth returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, output); err != nil {
		return errors.New("Modrinth returned an unexpected response")
	}
	return nil
}

type pluginManifest struct {
	Project       string `json:"project"`
	VersionID     string `json:"version_id"`
	VersionNumber string `json:"version_number"`
	FileName      string `json:"file_name"`
	SourceURL     string `json:"source_url"`
	SourceSHA512  string `json:"source_sha512"`
	LocalSHA256   string `json:"local_sha256"`
	InstalledPath string `json:"installed_path,omitempty"`
}

func (e *Executor) resolvePlugin(ctx context.Context, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	project := strings.ToLower(strings.TrimSpace(stringArg(step.Args, "project")))
	loader := strings.ToLower(strings.TrimSpace(stringArg(step.Args, "loader")))
	if loader == "" || loader == "unknown" {
		loader = strings.ToLower(strings.TrimSpace(stringArg(step.Args, "platform")))
	}
	minecraftVersion := strings.TrimSpace(stringArg(step.Args, "minecraft_version"))
	artifact, err := e.pluginResolver.Resolve(ctx, project, loader, minecraftVersion)
	if err != nil {
		return err
	}
	directory := e.pluginTaskDir(plan.TaskID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	artifactPath := filepath.Join(directory, "artifact.jar")
	if err := os.WriteFile(artifactPath, artifact.Contents, 0o600); err != nil {
		return err
	}
	manifest := pluginManifest{
		Project: artifact.Project, VersionID: artifact.VersionID, VersionNumber: artifact.VersionNumber,
		FileName: artifact.FileName, SourceURL: artifact.SourceURL, SourceSHA512: artifact.SourceSHA512,
		LocalSHA256: artifact.LocalSHA256,
	}
	encoded, _ := json.MarshalIndent(manifest, "", "  ")
	if err := os.WriteFile(filepath.Join(directory, "manifest.json"), encoded, 0o600); err != nil {
		return err
	}
	emit("", "plugin", fmt.Sprintf("已解析 Modrinth 插件 %s %s；来源 SHA-512 已验证，本地 SHA-256：%s", artifact.Project, artifact.VersionNumber, artifact.LocalSHA256))
	return nil
}

func (e *Executor) installPlugin(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	manifest, contents, err := e.loadPluginArtifact(plan.TaskID)
	if err != nil {
		return err
	}
	if project := strings.ToLower(strings.TrimSpace(stringArg(step.Args, "project"))); project != "" && project != manifest.Project {
		return errors.New("resolved plugin project does not match install step")
	}
	expected := strings.ToLower(strings.TrimSpace(stringArg(step.Args, "expected_sha256")))
	if expected != "" && expected != "${s1.sha256}" && expected != manifest.LocalSHA256 {
		return errors.New("plugin install SHA-256 does not match the resolved artifact")
	}
	uploader, ok := p.(interface {
		UploadFile(context.Context, string, string, string, []byte) error
	})
	if !ok {
		return errors.New("provider does not support controlled file uploads")
	}
	if err := uploader.UploadFile(ctx, plan.InstanceRef, "plugins", manifest.FileName, contents); err != nil {
		return err
	}
	manifest.InstalledPath = "plugins/" + manifest.FileName
	encoded, _ := json.MarshalIndent(manifest, "", "  ")
	if err := os.WriteFile(filepath.Join(e.pluginTaskDir(plan.TaskID), "manifest.json"), encoded, 0o600); err != nil {
		e.deleteUploadedPlugin(ctx, p, plan.InstanceRef, manifest.InstalledPath)
		return err
	}
	listing, err := p.ListFiles(ctx, plan.InstanceRef, "/plugins")
	if err != nil || !strings.Contains(listing, manifest.FileName) {
		e.deleteUploadedPlugin(ctx, p, plan.InstanceRef, manifest.InstalledPath)
		manifest.InstalledPath = ""
		encoded, _ = json.MarshalIndent(manifest, "", "  ")
		_ = os.WriteFile(filepath.Join(e.pluginTaskDir(plan.TaskID), "manifest.json"), encoded, 0o600)
		return errors.New("plugin upload completed without file-list evidence")
	}
	_ = os.Remove(filepath.Join(e.pluginTaskDir(plan.TaskID), "artifact.jar"))
	if e.audit != nil {
		e.audit.Append("plugin.install.committed", plan.TaskID, manifest.Project, map[string]any{
			"version": manifest.VersionNumber, "file": manifest.FileName,
			"source_sha512": manifest.SourceSHA512, "local_sha256": manifest.LocalSHA256,
		})
	}
	emit("", "files", fmt.Sprintf("插件已落盘到 /plugins/%s（SHA-256：%s）", manifest.FileName, manifest.LocalSHA256))
	return nil
}

func (e *Executor) deleteUploadedPlugin(ctx context.Context, p provider.Provider, instanceRef, target string) {
	if deleter, ok := p.(interface {
		DeleteFiles(context.Context, string, []string) error
	}); ok {
		_ = deleter.DeleteFiles(ctx, instanceRef, []string{target})
	}
}

func (e *Executor) loadPluginArtifact(taskID string) (pluginManifest, []byte, error) {
	directory := e.pluginTaskDir(taskID)
	raw, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return pluginManifest{}, nil, errors.New("plugin resolution manifest is missing")
	}
	var manifest pluginManifest
	if json.Unmarshal(raw, &manifest) != nil || !pluginProjectPattern.MatchString(manifest.Project) || filepath.Base(manifest.FileName) != manifest.FileName {
		return pluginManifest{}, nil, errors.New("plugin resolution manifest is invalid")
	}
	contents, err := os.ReadFile(filepath.Join(directory, "artifact.jar"))
	if err != nil {
		return pluginManifest{}, nil, errors.New("quarantined plugin artifact is missing")
	}
	local256 := sha256.Sum256(contents)
	local512 := sha512.Sum512(contents)
	if hex.EncodeToString(local256[:]) != manifest.LocalSHA256 || hex.EncodeToString(local512[:]) != manifest.SourceSHA512 {
		return pluginManifest{}, nil, errors.New("quarantined plugin artifact failed hash verification")
	}
	return manifest, contents, nil
}

func (e *Executor) pluginTaskDir(taskID string) string {
	sum := sha256.Sum256([]byte(taskID))
	return filepath.Join(e.dataDir, "plugin-quarantine", hex.EncodeToString(sum[:16]))
}

func (e *Executor) rollbackPlugin(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, emit EventSink) {
	raw, err := os.ReadFile(filepath.Join(e.pluginTaskDir(plan.TaskID), "manifest.json"))
	if err != nil {
		return
	}
	var manifest pluginManifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.InstalledPath == "" {
		return
	}
	deleter, ok := p.(interface {
		DeleteFiles(context.Context, string, []string) error
	})
	if !ok {
		emit("", "rollback", "插件验收失败，但当前 Provider 不支持受控删除，需要人工处理。")
		return
	}
	if err := deleter.DeleteFiles(ctx, plan.InstanceRef, []string{manifest.InstalledPath}); err != nil {
		emit("", "rollback", "插件验收失败且删除回滚失败："+sanitizeDiagnostic(err.Error()))
		return
	}
	emit("", "rollback", "插件验收失败，已删除 "+manifest.InstalledPath+"。")
}
