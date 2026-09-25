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
	"strconv"
	"strings"
	"time"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

const (
	modrinthAPI = "https://api.modrinth.com/v2"
	hangarAPI   = "https://hangar.papermc.io/api/v1"
	githubAPI   = "https://api.github.com"
)

var pluginProjectPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,63}$`)
var minecraftReleasePattern = regexp.MustCompile(`(?m)(?:^|[^0-9])(1\.\d+(?:\.\d+)?)(?:[^0-9]|$)`)
var errNoCompatiblePluginVersion = errors.New("no compatible plugin version")

type githubPluginSource struct {
	Owner       string
	Repository  string
	AssetPrefix string
}

var githubPluginSources = map[string]githubPluginSource{
	"essentialsx": {Owner: "EssentialsX", Repository: "Essentials", AssetPrefix: "EssentialsX-"},
}

// Hangar project identifiers preserve publisher capitalization. These are
// identity aliases only: resolution and compatibility still come from the
// official Hangar API, and an unlisted project is attempted with its supplied
// slug rather than being rejected by a hard-coded allow list.
var hangarProjectAliases = map[string]string{
	"essentials": "Essentials", "essentialsx": "Essentials",
	"placeholderapi": "PlaceholderAPI", "coreprotect": "CoreProtect",
	"viaversion": "ViaVersion", "viabackwards": "ViaBackwards",
	"geyser": "Geyser", "floodgate": "Floodgate", "luckperms": "LuckPerms",
}

type resolvedPlugin struct {
	Project       string
	VersionID     string
	VersionNumber string
	FileName      string
	SourceURL     string
	SourceSHA512  string
	LocalSHA256   string
	Source        string
	Compatibility string
	Contents      []byte
}

type pluginResolver interface {
	Resolve(context.Context, string, string, string, pluginResolutionProgress) (resolvedPlugin, error)
}

type pluginMetadataResolver interface {
	ResolveMetadata(context.Context, string, string, string, pluginResolutionProgress) (resolvedPlugin, error)
	Fetch(context.Context, pluginManifest) ([]byte, string, string, error)
}

type pluginResolutionProgress func(source, status string)

type officialPluginResolver struct {
	httpClient *http.Client
	apiBase    string
	hangarBase string
	githubBase string
}

func newOfficialPluginResolver() *officialPluginResolver {
	return &officialPluginResolver{httpClient: &http.Client{Timeout: 45 * time.Second}, apiBase: modrinthAPI, hangarBase: hangarAPI, githubBase: githubAPI}
}

func (r *officialPluginResolver) Resolve(ctx context.Context, project, loader, minecraftVersion string, progress pluginResolutionProgress) (resolvedPlugin, error) {
	return r.resolve(ctx, project, loader, minecraftVersion, progress, false)
}

func (r *officialPluginResolver) ResolveMetadata(ctx context.Context, project, loader, minecraftVersion string, progress pluginResolutionProgress) (resolvedPlugin, error) {
	return r.resolve(ctx, project, loader, minecraftVersion, progress, true)
}

func (r *officialPluginResolver) resolve(ctx context.Context, project, loader, minecraftVersion string, progress pluginResolutionProgress, metadataOnly bool) (resolvedPlugin, error) {
	project = strings.ToLower(strings.TrimSpace(project))
	reportPluginProgress(progress, "Modrinth", "正在查询兼容版本")
	artifact, modrinthErr := r.resolveModrinth(ctx, project, loader, minecraftVersion, metadataOnly)
	if modrinthErr == nil {
		reportPluginProgress(progress, "Modrinth", pluginResolutionStatus(metadataOnly))
		return artifact, nil
	}
	if !errors.Is(modrinthErr, errNoCompatiblePluginVersion) {
		reportPluginProgress(progress, "Modrinth", "查询或校验失败，停止来源回退")
		return resolvedPlugin{}, fmt.Errorf("Modrinth lookup failed: %w", modrinthErr)
	}
	var attempts []string
	attempts = append(attempts, "Modrinth: "+modrinthErr.Error())
	reportPluginProgress(progress, "Modrinth", "未找到可用制品，切换下一可信来源")
	if r.hangarBase != "" {
		reportPluginProgress(progress, "Hangar", "正在查询 PaperMC 官方插件仓库")
		artifact, hangarErr := r.resolveHangar(ctx, project, loader, minecraftVersion, metadataOnly)
		if hangarErr == nil {
			reportPluginProgress(progress, "Hangar", pluginResolutionStatus(metadataOnly))
			return artifact, nil
		}
		if !errors.Is(hangarErr, errNoCompatiblePluginVersion) {
			reportPluginProgress(progress, "Hangar", "查询或校验失败，停止来源回退")
			return resolvedPlugin{}, fmt.Errorf("Hangar lookup failed after Modrinth had no compatible version: %w", hangarErr)
		}
		attempts = append(attempts, "Hangar: "+hangarErr.Error())
		reportPluginProgress(progress, "Hangar", "未找到可用制品，切换下一可信来源")
	}
	source, supported := githubPluginSources[project]
	if supported {
		reportPluginProgress(progress, "official GitHub", "正在查询项目官方发布页")
		official, githubErr := r.resolveGitHubRelease(ctx, project, loader, minecraftVersion, source, metadataOnly)
		if githubErr == nil {
			reportPluginProgress(progress, "official GitHub", pluginResolutionStatus(metadataOnly))
			return official, nil
		}
		if !errors.Is(githubErr, errNoCompatiblePluginVersion) {
			reportPluginProgress(progress, "official GitHub", "查询或校验失败，停止来源回退")
			return resolvedPlugin{}, fmt.Errorf("official GitHub lookup failed after other sources had no compatible version: %w", githubErr)
		}
		attempts = append(attempts, "official GitHub: "+githubErr.Error())
		reportPluginProgress(progress, "official GitHub", "没有可用的已校验发布制品")
	}
	return resolvedPlugin{}, fmt.Errorf("%w: no trusted compatible artifact found after %d sources: %s", errNoCompatiblePluginVersion, len(attempts), strings.Join(attempts, "; "))
}

func pluginResolutionStatus(metadataOnly bool) string {
	if metadataOnly {
		return "已找到可信来源、兼容版本和制品校验元数据"
	}
	return "已找到并校验官方制品"
}

func reportPluginProgress(progress pluginResolutionProgress, source, status string) {
	if progress != nil {
		progress(source, status)
	}
}

func (r *officialPluginResolver) resolveHangar(ctx context.Context, project, loader, minecraftVersion string, metadataOnly bool) (resolvedPlugin, error) {
	loader = strings.ToLower(strings.TrimSpace(loader))
	if loader == "purpur" || loader == "spigot" || loader == "bukkit" {
		loader = "paper"
	}
	if loader != "paper" {
		return resolvedPlugin{}, fmt.Errorf("Hangar supports Paper-compatible plugin resolution; got %q", loader)
	}
	if !minecraftVersionPattern.MatchString(minecraftVersion) {
		return resolvedPlugin{}, errors.New("Hangar resolution requires a valid Minecraft version")
	}
	projectID := project
	if alias := hangarProjectAliases[project]; alias != "" {
		projectID = alias
	} else {
		discovered, err := r.findExactHangarProject(ctx, project, minecraftVersion)
		if err != nil {
			return resolvedPlugin{}, err
		}
		projectID = discovered
	}
	endpoint := strings.TrimRight(r.hangarBase, "/") + "/projects/" + url.PathEscape(projectID) + "/versions?limit=25&offset=0"
	var response struct {
		Result []struct {
			ID          int64  `json:"id"`
			Name        string `json:"name"`
			Visibility  string `json:"visibility"`
			ReviewState string `json:"reviewState"`
			Channel     struct {
				Name string `json:"name"`
			} `json:"channel"`
			Downloads map[string]struct {
				FileInfo struct {
					Name       string `json:"name"`
					SizeBytes  int64  `json:"sizeBytes"`
					SHA256Hash string `json:"sha256Hash"`
				} `json:"fileInfo"`
				ExternalURL string `json:"externalUrl"`
				DownloadURL string `json:"downloadUrl"`
			} `json:"downloads"`
			PluginDependencies map[string][]struct {
				Name     string `json:"name"`
				Required *bool  `json:"required"`
			} `json:"pluginDependencies"`
			PlatformDependencies map[string][]string `json:"platformDependencies"`
		} `json:"result"`
	}
	if err := r.getHangarJSON(ctx, endpoint, &response); err != nil {
		return resolvedPlugin{}, err
	}
	for _, version := range response.Result {
		if version.ID <= 0 || version.Name == "" || version.Visibility != "public" || !strings.EqualFold(version.Channel.Name, "Release") {
			continue
		}
		compatible := false
		for _, candidate := range version.PlatformDependencies["PAPER"] {
			if candidate == minecraftVersion {
				compatible = true
				break
			}
		}
		if !compatible {
			continue
		}
		for _, dependency := range version.PluginDependencies["PAPER"] {
			if dependency.Required == nil || *dependency.Required {
				return resolvedPlugin{}, fmt.Errorf("Hangar release %s declares required plugin dependency %s that needs separate approval", version.Name, dependency.Name)
			}
		}
		download, ok := version.Downloads["PAPER"]
		if !ok {
			continue
		}
		if download.ExternalURL != "" && download.DownloadURL == "" {
			return r.resolveReviewedHangarGitHubAsset(ctx, project, version.ID, version.Name, download.ExternalURL, metadataOnly)
		}
		if download.DownloadURL == "" {
			continue
		}
		if filepath.Base(download.FileInfo.Name) != download.FileInfo.Name || !strings.HasSuffix(strings.ToLower(download.FileInfo.Name), ".jar") {
			return resolvedPlugin{}, errors.New("Hangar did not provide a safe JAR filename")
		}
		declared256 := strings.ToLower(strings.TrimSpace(download.FileInfo.SHA256Hash))
		if len(declared256) != 64 || download.FileInfo.SizeBytes <= 0 || download.FileInfo.SizeBytes > 64<<20 {
			return resolvedPlugin{}, errors.New("Hangar release has incomplete artifact integrity metadata")
		}
		artifactURL, err := url.Parse(download.DownloadURL)
		trustedOfficial := err == nil && artifactURL.Scheme == "https" && artifactURL.Hostname() == "hangarcdn.papermc.io"
		trustedTest := r.hangarBase != hangarAPI && err == nil && (artifactURL.Scheme == "http" || artifactURL.Scheme == "https")
		if !trustedOfficial && !trustedTest {
			return resolvedPlugin{}, errors.New("Hangar returned an untrusted artifact URL")
		}
		if metadataOnly {
			return resolvedPlugin{Project: project, VersionID: strconv.FormatInt(version.ID, 10), VersionNumber: version.Name,
				FileName: download.FileInfo.Name, SourceURL: download.DownloadURL, LocalSHA256: declared256,
				Source: "hangar", Compatibility: "exact-game-version"}, nil
		}
		contents, err := r.downloadPluginArtifact(ctx, download.DownloadURL)
		if err != nil {
			return resolvedPlugin{}, err
		}
		if int64(len(contents)) != download.FileInfo.SizeBytes {
			return resolvedPlugin{}, errors.New("Hangar artifact size does not match metadata")
		}
		actual256 := sha256.Sum256(contents)
		if hex.EncodeToString(actual256[:]) != declared256 {
			return resolvedPlugin{}, errors.New("Hangar artifact SHA-256 does not match metadata")
		}
		actual512 := sha512.Sum512(contents)
		return resolvedPlugin{
			Project: project, VersionID: strconv.FormatInt(version.ID, 10), VersionNumber: version.Name,
			FileName: download.FileInfo.Name, SourceURL: download.DownloadURL,
			SourceSHA512: hex.EncodeToString(actual512[:]), LocalSHA256: declared256,
			Source: "hangar", Compatibility: "exact-game-version", Contents: contents,
		}, nil
	}
	return resolvedPlugin{}, fmt.Errorf("%w: Hangar has no release compatible with Minecraft %s", errNoCompatiblePluginVersion, minecraftVersion)
}

func (r *officialPluginResolver) resolveReviewedHangarGitHubAsset(ctx context.Context, project string, versionID int64, versionNumber, externalURL string, metadataOnly bool) (resolvedPlugin, error) {
	artifactURL, err := url.Parse(externalURL)
	if err != nil || artifactURL.Scheme != "https" || artifactURL.Hostname() != "github.com" {
		return resolvedPlugin{}, errors.New("reviewed Hangar release points to an unsupported external host")
	}
	parts := strings.Split(strings.Trim(artifactURL.Path, "/"), "/")
	if len(parts) < 6 || parts[2] != "releases" || parts[3] != "download" {
		return resolvedPlugin{}, errors.New("reviewed Hangar GitHub URL is not a release asset")
	}
	owner, repository, tag := parts[0], parts[1], parts[4]
	assetName, err := url.PathUnescape(strings.Join(parts[5:], "/"))
	if err != nil || filepath.Base(assetName) != assetName || !strings.HasSuffix(strings.ToLower(assetName), ".jar") {
		return resolvedPlugin{}, errors.New("reviewed Hangar GitHub URL has an unsafe asset name")
	}
	if r.githubBase == "" {
		return resolvedPlugin{}, errors.New("GitHub metadata verification is unavailable")
	}
	endpoint := strings.TrimRight(r.githubBase, "/") + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repository) + "/releases/tags/" + url.PathEscape(tag)
	var release struct {
		Draft      bool `json:"draft"`
		Prerelease bool `json:"prerelease"`
		Assets     []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
			Digest             string `json:"digest"`
			Size               int64  `json:"size"`
		} `json:"assets"`
	}
	if err := r.getGitHubJSON(ctx, endpoint, &release); err != nil {
		return resolvedPlugin{}, fmt.Errorf("verify reviewed Hangar external release: %w", err)
	}
	if release.Draft || release.Prerelease {
		return resolvedPlugin{}, errors.New("reviewed Hangar external release is not stable")
	}
	for _, asset := range release.Assets {
		if asset.Name != assetName || asset.BrowserDownloadURL != externalURL {
			continue
		}
		declared256 := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(asset.Digest)), "sha256:")
		if len(declared256) != 64 || asset.Size <= 0 || asset.Size > 64<<20 {
			return resolvedPlugin{}, errors.New("GitHub release asset has incomplete integrity metadata")
		}
		if metadataOnly {
			return resolvedPlugin{Project: project, VersionID: strconv.FormatInt(versionID, 10), VersionNumber: versionNumber,
				FileName: assetName, SourceURL: externalURL, LocalSHA256: declared256,
				Source: "hangar-reviewed-github", Compatibility: "exact-game-version"}, nil
		}
		contents, err := r.downloadPluginArtifact(ctx, externalURL)
		if err != nil {
			return resolvedPlugin{}, err
		}
		if int64(len(contents)) != asset.Size {
			return resolvedPlugin{}, errors.New("GitHub release asset size does not match metadata")
		}
		actual256 := sha256.Sum256(contents)
		if hex.EncodeToString(actual256[:]) != declared256 {
			return resolvedPlugin{}, errors.New("GitHub release asset SHA-256 does not match metadata")
		}
		actual512 := sha512.Sum512(contents)
		return resolvedPlugin{
			Project: project, VersionID: strconv.FormatInt(versionID, 10), VersionNumber: versionNumber,
			FileName: assetName, SourceURL: externalURL, SourceSHA512: hex.EncodeToString(actual512[:]),
			LocalSHA256: declared256, Source: "hangar-reviewed-github", Compatibility: "exact-game-version", Contents: contents,
		}, nil
	}
	return resolvedPlugin{}, errors.New("GitHub release API did not contain the exact Hangar-linked asset")
}

func (r *officialPluginResolver) findExactHangarProject(ctx context.Context, query, minecraftVersion string) (string, error) {
	endpoint := strings.TrimRight(r.hangarBase, "/") + "/projects?query=" + url.QueryEscape(query) + "&limit=25&offset=0"
	var response struct {
		Result []struct {
			Name       string `json:"name"`
			Visibility string `json:"visibility"`
			Namespace  struct {
				Slug string `json:"slug"`
			} `json:"namespace"`
			SupportedPlatforms map[string][]string `json:"supportedPlatforms"`
		} `json:"result"`
	}
	if err := r.getHangarJSON(ctx, endpoint, &response); err != nil {
		return "", fmt.Errorf("search Hangar projects: %w", err)
	}
	normalizedQuery := normalizePluginIdentity(query)
	for _, candidate := range response.Result {
		if candidate.Visibility != "public" || (normalizePluginIdentity(candidate.Name) != normalizedQuery && normalizePluginIdentity(candidate.Namespace.Slug) != normalizedQuery) {
			continue
		}
		for _, version := range candidate.SupportedPlatforms["PAPER"] {
			if version == minecraftVersion {
				return candidate.Namespace.Slug, nil
			}
		}
	}
	return "", fmt.Errorf("%w: Hangar search found no exact public project compatible with Minecraft %s", errNoCompatiblePluginVersion, minecraftVersion)
}

func normalizePluginIdentity(value string) string {
	return strings.Map(func(character rune) rune {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			return character
		}
		if character >= 'A' && character <= 'Z' {
			return character + ('a' - 'A')
		}
		return -1
	}, value)
}

func (r *officialPluginResolver) resolveModrinth(ctx context.Context, project, loader, minecraftVersion string, metadataOnly bool) (resolvedPlugin, error) {
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
		return resolvedPlugin{}, fmt.Errorf("%w: Modrinth has no %s version compatible with %s", errNoCompatiblePluginVersion, project, minecraftVersion)
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
	if err != nil || artifactURL == nil {
		return resolvedPlugin{}, errors.New("Modrinth returned an untrusted artifact URL")
	}
	trustedOfficial := artifactURL.Scheme == "https" && artifactURL.Hostname() == "cdn.modrinth.com"
	trustedTest := r.apiBase != modrinthAPI && (artifactURL.Scheme == "http" || artifactURL.Scheme == "https")
	if !trustedOfficial && !trustedTest {
		return resolvedPlugin{}, errors.New("Modrinth returned an untrusted artifact URL")
	}
	declared := strings.ToLower(selected.Hashes.SHA512)
	if metadataOnly {
		return resolvedPlugin{Project: project, VersionID: version.ID, VersionNumber: version.VersionNumber,
			FileName: selected.Filename, SourceURL: selected.URL, SourceSHA512: declared,
			Source: "modrinth", Compatibility: "exact-game-version"}, nil
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
	actual512 := sha512.Sum512(contents)
	if hex.EncodeToString(actual512[:]) != declared {
		return resolvedPlugin{}, errors.New("plugin artifact SHA-512 does not match Modrinth metadata")
	}
	actual256 := sha256.Sum256(contents)
	return resolvedPlugin{
		Project: project, VersionID: version.ID, VersionNumber: version.VersionNumber,
		FileName: selected.Filename, SourceURL: selected.URL, SourceSHA512: declared,
		LocalSHA256: hex.EncodeToString(actual256[:]), Source: "modrinth",
		Compatibility: "exact-game-version", Contents: contents,
	}, nil
}

func (r *officialPluginResolver) resolveGitHubRelease(ctx context.Context, project, loader, minecraftVersion string, source githubPluginSource, metadataOnly bool) (resolvedPlugin, error) {
	loader = strings.ToLower(strings.TrimSpace(loader))
	if loader == "purpur" || loader == "spigot" || loader == "bukkit" {
		loader = "paper"
	}
	if loader != "paper" {
		return resolvedPlugin{}, fmt.Errorf("official plugin source supports Paper-compatible servers; got %q", loader)
	}
	if !minecraftVersionPattern.MatchString(minecraftVersion) {
		return resolvedPlugin{}, errors.New("official plugin resolution requires a valid Minecraft version")
	}
	endpoint := strings.TrimRight(r.githubBase, "/") + "/repos/" + url.PathEscape(source.Owner) + "/" + url.PathEscape(source.Repository) + "/releases?per_page=20"
	var releases []struct {
		ID         int64  `json:"id"`
		TagName    string `json:"tag_name"`
		Body       string `json:"body"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Assets     []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
			Digest             string `json:"digest"`
		} `json:"assets"`
	}
	if err := r.getGitHubJSON(ctx, endpoint, &releases); err != nil {
		return resolvedPlugin{}, err
	}
	for _, release := range releases {
		if release.Draft || release.Prerelease || release.ID <= 0 || release.TagName == "" {
			continue
		}
		compatibility, ok := officialReleaseCompatibility(release.Body, minecraftVersion)
		if !ok {
			continue
		}
		version := strings.TrimPrefix(release.TagName, "v")
		expectedName := source.AssetPrefix + version + ".jar"
		for _, asset := range release.Assets {
			if asset.Name != expectedName || filepath.Base(asset.Name) != asset.Name {
				continue
			}
			declared256 := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(asset.Digest)), "sha256:")
			if len(declared256) != 64 {
				return resolvedPlugin{}, errors.New("official GitHub release asset has no SHA-256 digest")
			}
			if _, err := hex.DecodeString(declared256); err != nil {
				return resolvedPlugin{}, errors.New("official GitHub release asset has an invalid SHA-256 digest")
			}
			artifactURL, err := url.Parse(asset.BrowserDownloadURL)
			trustedOfficial := err == nil && artifactURL.Scheme == "https" && artifactURL.Hostname() == "github.com"
			trustedTest := r.githubBase != githubAPI && err == nil && (artifactURL.Scheme == "http" || artifactURL.Scheme == "https")
			if !trustedOfficial && !trustedTest {
				return resolvedPlugin{}, errors.New("official GitHub release returned an untrusted artifact URL")
			}
			if metadataOnly {
				return resolvedPlugin{Project: project, VersionID: strconv.FormatInt(release.ID, 10), VersionNumber: version,
					FileName: asset.Name, SourceURL: asset.BrowserDownloadURL, LocalSHA256: declared256,
					Source: "github-official", Compatibility: compatibility}, nil
			}
			contents, err := r.downloadPluginArtifact(ctx, artifactURL.String())
			if err != nil {
				return resolvedPlugin{}, err
			}
			actual256 := sha256.Sum256(contents)
			if hex.EncodeToString(actual256[:]) != declared256 {
				return resolvedPlugin{}, errors.New("official GitHub release artifact SHA-256 does not match metadata")
			}
			actual512 := sha512.Sum512(contents)
			return resolvedPlugin{
				Project: project, VersionID: strconv.FormatInt(release.ID, 10), VersionNumber: version,
				FileName: asset.Name, SourceURL: asset.BrowserDownloadURL,
				SourceSHA512: hex.EncodeToString(actual512[:]), LocalSHA256: declared256,
				Source: "github-official", Compatibility: compatibility, Contents: contents,
			}, nil
		}
		return resolvedPlugin{}, fmt.Errorf("official GitHub release %s has no expected core JAR", release.TagName)
	}
	return resolvedPlugin{}, fmt.Errorf("%w: official GitHub releases do not declare support for Minecraft %s", errNoCompatiblePluginVersion, minecraftVersion)
}

func officialReleaseCompatibility(body, minecraftVersion string) (string, bool) {
	target := strings.Split(minecraftVersion, ".")
	if len(target) < 2 {
		return "", false
	}
	train := target[0] + "." + target[1]
	inSupportedSection := false
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## ") {
			inSupportedSection = strings.Contains(strings.ToLower(trimmed), "supported server versions")
			continue
		}
		if !inSupportedSection || (!strings.Contains(trimmed, "✅") && !strings.Contains(trimmed, "⚠")) {
			continue
		}
		for _, match := range minecraftReleasePattern.FindAllStringSubmatch(trimmed, -1) {
			candidate := strings.Split(match[1], ".")
			if len(candidate) >= 2 && candidate[0]+"."+candidate[1] == train {
				if match[1] == minecraftVersion {
					return "official-exact:" + match[1], true
				}
				return "official-release-train:" + train, true
			}
		}
	}
	return "", false
}

func (r *officialPluginResolver) downloadPluginArtifact(ctx context.Context, endpoint string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("User-Agent", "MCAI-Sidecar/0.1 (controlled-plugin-resolver)")
	response, err := r.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("official plugin download returned HTTP %d", response.StatusCode)
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, (64<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(contents) == 0 || len(contents) > 64<<20 {
		return nil, errors.New("plugin artifact size is outside the 1 byte to 64 MiB limit")
	}
	return contents, nil
}

func (r *officialPluginResolver) Fetch(ctx context.Context, manifest pluginManifest) ([]byte, string, string, error) {
	contents, err := r.downloadPluginArtifact(ctx, manifest.SourceURL)
	if err != nil {
		return nil, "", "", err
	}
	actual256 := sha256.Sum256(contents)
	actual512 := sha512.Sum512(contents)
	sha256Value := hex.EncodeToString(actual256[:])
	sha512Value := hex.EncodeToString(actual512[:])
	if manifest.LocalSHA256 != "" && !strings.EqualFold(manifest.LocalSHA256, sha256Value) {
		return nil, "", "", errors.New("plugin artifact SHA-256 does not match trusted metadata")
	}
	if manifest.SourceSHA512 != "" && !strings.EqualFold(manifest.SourceSHA512, sha512Value) {
		return nil, "", "", errors.New("plugin artifact SHA-512 does not match trusted metadata")
	}
	return contents, sha256Value, sha512Value, nil
}

func (r *officialPluginResolver) getGitHubJSON(ctx context.Context, endpoint string, output any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "MCAI-Sidecar/0.1 (controlled-plugin-resolver)")
	response, err := r.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("official GitHub API returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, output); err != nil {
		return errors.New("official GitHub API returned an unexpected response")
	}
	return nil
}

func (r *officialPluginResolver) getHangarJSON(ctx context.Context, endpoint string, output any) error {
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
		if response.StatusCode == http.StatusNotFound {
			return fmt.Errorf("%w: Hangar API returned HTTP 404", errNoCompatiblePluginVersion)
		}
		return fmt.Errorf("Hangar API returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, output); err != nil {
		return errors.New("Hangar API returned an unexpected response")
	}
	return nil
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
		if response.StatusCode == http.StatusNotFound {
			return fmt.Errorf("%w: Modrinth returned HTTP 404", errNoCompatiblePluginVersion)
		}
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
	Source        string `json:"source"`
	Compatibility string `json:"compatibility"`
	InstalledPath string `json:"installed_path,omitempty"`
}

func (e *Executor) resolvePlugin(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	project := strings.ToLower(strings.TrimSpace(stringArg(step.Args, "project")))
	loader := strings.ToLower(strings.TrimSpace(stringArg(step.Args, "loader")))
	if loader == "" || loader == "unknown" {
		loader = strings.ToLower(strings.TrimSpace(stringArg(step.Args, "platform")))
	}
	minecraftVersion := strings.TrimSpace(stringArg(step.Args, "minecraft_version"))
	if loader == "" || loader == "unknown" || !minecraftVersionPattern.MatchString(minecraftVersion) {
		detectedLoader, detectedVersion := detectPluginTarget(ctx, p, plan.InstanceRef)
		if loader == "" || loader == "unknown" {
			loader = detectedLoader
		}
		if !minecraftVersionPattern.MatchString(minecraftVersion) {
			minecraftVersion = detectedVersion
		}
		if loader != "" && loader != "unknown" && minecraftVersionPattern.MatchString(minecraftVersion) {
			emit("", "inventory", fmt.Sprintf("已从当前实例日志与文件识别服务端：%s %s", loader, minecraftVersion))
		}
	}
	progress := func(source, status string) {
		emit("", "source", fmt.Sprintf("%s：%s", source, status))
	}
	var artifact resolvedPlugin
	var err error
	if resolver, ok := e.pluginResolver.(pluginMetadataResolver); ok {
		artifact, err = resolver.ResolveMetadata(ctx, project, loader, minecraftVersion, progress)
	} else {
		artifact, err = e.pluginResolver.Resolve(ctx, project, loader, minecraftVersion, progress)
	}
	if err != nil {
		if errors.Is(err, errNoCompatiblePluginVersion) {
			emit("", "plugin", fmt.Sprintf("Plugin resolve result: project=%s; resolution=no-compatible-artifact; compatibility=incompatible; checked_source=modrinth; requested_loader=%s; requested_minecraft_version=%s", project, loader, minecraftVersion))
			return nil
		}
		return err
	}
	directory := e.pluginTaskDir(plan.TaskID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if len(artifact.Contents) > 0 {
		artifactPath := filepath.Join(directory, "artifact.jar")
		if err := os.WriteFile(artifactPath, artifact.Contents, 0o600); err != nil {
			return err
		}
	}
	manifest := pluginManifest{
		Project: artifact.Project, VersionID: artifact.VersionID, VersionNumber: artifact.VersionNumber,
		FileName: artifact.FileName, SourceURL: artifact.SourceURL, SourceSHA512: artifact.SourceSHA512,
		LocalSHA256: artifact.LocalSHA256, Source: artifact.Source, Compatibility: artifact.Compatibility,
	}
	encoded, _ := json.MarshalIndent(manifest, "", "  ")
	if err := os.WriteFile(filepath.Join(directory, "manifest.json"), encoded, 0o600); err != nil {
		return err
	}
	emit("", "plugin", fmt.Sprintf("Plugin resolve result: project=%s; version=%s; source=%s; artifact=%s; compatibility=%s; sha256=%s; source_sha512=%s", artifact.Project, artifact.VersionNumber, artifact.Source, artifact.FileName, artifact.Compatibility, artifact.LocalSHA256, artifact.SourceSHA512))
	return nil
}

func detectPluginTarget(ctx context.Context, p provider.Provider, instanceRef string) (string, string) {
	loader, version := "unknown", ""
	if instance, err := p.GetInstance(ctx, instanceRef); err == nil {
		loader = strings.ToLower(strings.TrimSpace(instance.Loader))
		if loader == "" || loader == "unknown" {
			loader = strings.ToLower(strings.TrimSpace(instance.Platform))
		}
		version = strings.TrimSpace(instance.MinecraftVersion)
	}
	var evidence strings.Builder
	if output, err := p.ReadOutput(ctx, instanceRef, 256); err == nil {
		evidence.WriteString(output)
		evidence.WriteByte('\n')
	}
	if latest, err := p.ReadFile(ctx, instanceRef, "logs/latest.log"); err == nil {
		evidence.Write(latest)
		evidence.WriteByte('\n')
	}
	if listing, err := p.ListFiles(ctx, instanceRef, "/"); err == nil {
		evidence.WriteString(listing)
	}
	text := evidence.String()
	lower := strings.ToLower(text)
	if loader == "" || loader == "unknown" {
		switch {
		case strings.Contains(lower, "paper"):
			loader = "paper"
		case strings.Contains(lower, "purpur"):
			loader = "purpur"
		case strings.Contains(lower, "fabric"):
			loader = "fabric"
		case strings.Contains(lower, "forge"):
			loader = "forge"
		case strings.Contains(lower, "spigot.yml") || strings.Contains(lower, "bukkit.yml"):
			loader = "spigot"
		}
	}
	if !minecraftVersionPattern.MatchString(version) {
		patterns := []*regexp.Regexp{
			regexp.MustCompile(`(?i)(?:minecraft(?:\s+server)?\s+version|implementing\s+api\s+version|\bmc\s*[:=])[^0-9]{0,32}(1\.\d+(?:\.\d+)?)`),
			regexp.MustCompile(`(?i)\bpaper(?:\s+version)?\s+[^\r\n]{0,48}?\b(1\.\d+(?:\.\d+)?)\b`),
		}
		for _, pattern := range patterns {
			if match := pattern.FindStringSubmatch(text); len(match) == 2 {
				version = match[1]
				break
			}
		}
	}
	return loader, version
}

func (e *Executor) installPlugin(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	sourceTaskID := strings.TrimSpace(stringArg(step.Args, "source_task_id"))
	if sourceTaskID == "" {
		sourceTaskID = plan.TaskID
	}
	manifest, contents, err := e.loadPluginArtifact(sourceTaskID)
	if err != nil && strings.Contains(err.Error(), "artifact is missing") {
		resolver, ok := e.pluginResolver.(pluginMetadataResolver)
		if !ok {
			return err
		}
		contents, manifest.LocalSHA256, manifest.SourceSHA512, err = resolver.Fetch(ctx, manifest)
		if err == nil {
			encoded, _ := json.MarshalIndent(manifest, "", "  ")
			directory := e.pluginTaskDir(sourceTaskID)
			err = os.WriteFile(filepath.Join(directory, "manifest.json"), encoded, 0o600)
			if err == nil {
				err = os.WriteFile(filepath.Join(directory, "artifact.jar"), contents, 0o600)
			}
		}
	}
	if err != nil {
		return err
	}
	if project := strings.ToLower(strings.TrimSpace(stringArg(step.Args, "project"))); project != "" && project != manifest.Project {
		return errors.New("resolved plugin project does not match install step")
	}
	expectedAlgorithm, expectedValue := pluginExpectedIntegrity(step.Args)
	if expectedValue != "" {
		manifestValue := manifest.LocalSHA256
		if expectedAlgorithm == "sha512" {
			manifestValue = manifest.SourceSHA512
		}
		if !strings.EqualFold(expectedValue, manifestValue) {
			return errors.New("plugin install integrity does not match the resolved artifact")
		}
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
	if err := os.MkdirAll(e.pluginTaskDir(plan.TaskID), 0o700); err != nil {
		e.deleteUploadedPlugin(ctx, p, plan.InstanceRef, manifest.InstalledPath)
		return err
	}
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
	_ = os.Remove(filepath.Join(e.pluginTaskDir(sourceTaskID), "artifact.jar"))
	if e.audit != nil {
		e.audit.Append("plugin.install.committed", plan.TaskID, manifest.Project, map[string]any{
			"version": manifest.VersionNumber, "file": manifest.FileName,
			"source_sha512": manifest.SourceSHA512, "local_sha256": manifest.LocalSHA256,
		})
	}
	emit("", "files", fmt.Sprintf("插件已落盘到 /plugins/%s（SHA-256：%s）", manifest.FileName, manifest.LocalSHA256))
	return nil
}

func pluginExpectedIntegrity(args map[string]any) (string, string) {
	if value, ok := args["expected_integrity"].(map[string]any); ok {
		return strings.ToLower(strings.TrimSpace(stringArg(value, "algorithm"))), strings.ToLower(strings.TrimSpace(stringArg(value, "value")))
	}
	// Legacy deterministic plans remain readable during rolling upgrades.
	return "sha256", strings.ToLower(strings.TrimSpace(stringArg(args, "expected_sha256")))
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
		return manifest, nil, errors.New("quarantined plugin artifact is missing")
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
