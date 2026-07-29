package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	paperBuildsEndpoint   = "https://fill.papermc.io/v3/projects/paper/versions/%s/builds"
	fabricLoadersEndpoint = "https://meta.fabricmc.net/v2/versions/loader/%s"
)

var minecraftVersionPattern = regexp.MustCompile(`^\d+\.\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9._-]+)?$`)

type releaseArtifact struct {
	Platform         string
	MinecraftVersion string
	URL              string
	Name             string
	SHA256           string
	Size             int64
}

type releaseResolver interface {
	Resolve(context.Context, string, string) (releaseArtifact, error)
}

type officialReleaseResolver struct {
	httpClient       *http.Client
	paperBuildsURL   string
	fabricLoadersURL string
}

func newOfficialReleaseResolver() *officialReleaseResolver {
	return &officialReleaseResolver{
		httpClient:       &http.Client{Timeout: 20 * time.Second},
		paperBuildsURL:   paperBuildsEndpoint,
		fabricLoadersURL: fabricLoadersEndpoint,
	}
}

func (r *officialReleaseResolver) Resolve(ctx context.Context, platform, minecraftVersion string) (releaseArtifact, error) {
	platform = strings.ToLower(strings.TrimSpace(platform))
	minecraftVersion = strings.TrimSpace(minecraftVersion)
	if platform != "paper" && platform != "fabric" {
		return releaseArtifact{}, fmt.Errorf("unsupported server platform %q; supported platforms are Paper and Fabric", platform)
	}
	if !minecraftVersionPattern.MatchString(minecraftVersion) {
		return releaseArtifact{}, errors.New("Minecraft version must be a release identifier such as 1.21.1")
	}
	if platform == "paper" {
		return r.resolvePaper(ctx, minecraftVersion)
	}
	return r.resolveFabric(ctx, minecraftVersion)
}

type paperBuild struct {
	ID        int    `json:"id"`
	Channel   string `json:"channel"`
	Downloads map[string]struct {
		Name      string `json:"name"`
		URL       string `json:"url"`
		Size      int64  `json:"size"`
		Checksums struct {
			SHA256 string `json:"sha256"`
		} `json:"checksums"`
	} `json:"downloads"`
}

func (r *officialReleaseResolver) resolvePaper(ctx context.Context, minecraftVersion string) (releaseArtifact, error) {
	var builds []paperBuild
	endpoint := fmt.Sprintf(r.paperBuildsURL, url.PathEscape(minecraftVersion))
	if err := r.getJSON(ctx, endpoint, &builds); err != nil {
		return releaseArtifact{}, fmt.Errorf("resolve official Paper %s build: %w", minecraftVersion, err)
	}
	for _, build := range builds {
		if build.Channel != "STABLE" {
			continue
		}
		download, ok := build.Downloads["server:default"]
		if !ok || download.Name == "" || download.Size < 1<<20 || !isSHA256(download.Checksums.SHA256) || !isOfficialPaperDownload(download.URL) {
			continue
		}
		return releaseArtifact{
			Platform:         "paper",
			MinecraftVersion: minecraftVersion,
			URL:              download.URL,
			Name:             download.Name,
			SHA256:           strings.ToLower(download.Checksums.SHA256),
			Size:             download.Size,
		}, nil
	}
	return releaseArtifact{}, fmt.Errorf("no stable official Paper build is available for Minecraft %s", minecraftVersion)
}

type fabricLoader struct {
	Loader struct {
		Version string `json:"version"`
		Stable  bool   `json:"stable"`
	} `json:"loader"`
	Installer struct {
		Version string `json:"version"`
		Stable  bool   `json:"stable"`
	} `json:"installer"`
}

func (r *officialReleaseResolver) resolveFabric(ctx context.Context, minecraftVersion string) (releaseArtifact, error) {
	var loaders []fabricLoader
	endpoint := fmt.Sprintf(r.fabricLoadersURL, url.PathEscape(minecraftVersion))
	if err := r.getJSON(ctx, endpoint, &loaders); err != nil {
		return releaseArtifact{}, fmt.Errorf("resolve official Fabric %s loader: %w", minecraftVersion, err)
	}
	for _, candidate := range loaders {
		if !candidate.Loader.Stable || !candidate.Installer.Stable || !isFabricComponent(candidate.Loader.Version) || !isFabricComponent(candidate.Installer.Version) {
			continue
		}
		return releaseArtifact{
			Platform:         "fabric",
			MinecraftVersion: minecraftVersion,
			URL:              "https://meta.fabricmc.net/v2/versions/loader/" + url.PathEscape(minecraftVersion) + "/" + url.PathEscape(candidate.Loader.Version) + "/" + url.PathEscape(candidate.Installer.Version) + "/server/jar",
			Name:             "fabric-server-launch.jar",
		}, nil
	}
	return releaseArtifact{}, fmt.Errorf("no stable official Fabric loader is available for Minecraft %s", minecraftVersion)
}

func (r *officialReleaseResolver) getJSON(ctx context.Context, endpoint string, output any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "MCAI-Sidecar/0.1 (official-release-resolver)")
	response, err := r.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("official release service returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, output); err != nil {
		return errors.New("official release service returned an unexpected response")
	}
	return nil
}

func isOfficialPaperDownload(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return u.Scheme == "https" && u.Host == "fill-data.papermc.io" && strings.HasPrefix(u.Path, "/v1/objects/")
}

func isSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') && !(character >= 'A' && character <= 'F') {
			return false
		}
	}
	return true
}

func isFabricComponent(value string) bool {
	return regexp.MustCompile(`^[A-Za-z0-9._-]+$`).MatchString(value)
}
