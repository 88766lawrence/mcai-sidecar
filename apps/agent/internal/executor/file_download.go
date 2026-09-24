package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/mcai/sidecar-agent/internal/protocol"
	"github.com/mcai/sidecar-agent/internal/provider"
)

const maxPublicDownloadBytes = 64 << 20

type fileDownloadFetcher interface {
	Fetch(context.Context, string) ([]byte, error)
}

type secureFileDownloadFetcher struct {
	httpClient *http.Client
}

func newSecureFileDownloadFetcher() fileDownloadFetcher {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = publicInternetDialContext
	transport.ResponseHeaderTimeout = 20 * time.Second
	transport.MaxConnsPerHost = 2
	return &secureFileDownloadFetcher{httpClient: &http.Client{
		Transport: transport,
		Timeout:   90 * time.Second,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("public download exceeded five redirects")
			}
			return validatePublicDownloadURL(next.URL)
		},
	}}
}

func (f *secureFileDownloadFetcher) Fetch(ctx context.Context, source string) ([]byte, error) {
	parsed, err := url.Parse(source)
	if err != nil || validatePublicDownloadURL(parsed) != nil {
		return nil, errors.New("download URL must address the public HTTP(S) internet")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "*/*")
	request.Header.Set("User-Agent", "MCAI-Sidecar/0.1 (task-file-download)")
	response, err := f.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("public download request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("public download returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxPublicDownloadBytes {
		return nil, errors.New("public download exceeds the 64 MiB transfer limit")
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, maxPublicDownloadBytes+1))
	if err != nil {
		return nil, err
	}
	if len(contents) == 0 || len(contents) > maxPublicDownloadBytes {
		return nil, errors.New("public download must contain between 1 byte and 64 MiB")
	}
	return contents, nil
}

func (e *Executor) downloadFile(ctx context.Context, p provider.Provider, plan protocol.TaskPlan, step protocol.TaskStep, emit EventSink) error {
	source, target, expectedSHA, err := validatedFileDownloadArgs(step.Args)
	if err != nil {
		return err
	}
	lister, listOK := p.(provider.StructuredFileLister)
	creator, createOK := p.(provider.BinaryFileCreator)
	reader, readOK := p.(provider.BinaryFileReader)
	if !listOK || !createOK || !readOK {
		return errors.New("provider does not support verified create-only binary downloads")
	}
	parent, name := path.Dir(target), path.Base(target)
	before, err := lister.ListFileEntries(ctx, plan.InstanceRef, parent)
	if err != nil {
		return fmt.Errorf("check download target: %w", err)
	}
	if before.Truncated {
		return errors.New("download target directory listing is truncated; absence cannot be proven")
	}
	if containsExactFileName(before.Names, name) {
		return errors.New("download target already exists; file.download never overwrites")
	}
	if e.fileDownloader == nil {
		return errors.New("public file downloader is not configured")
	}
	contents, err := e.fileDownloader.Fetch(ctx, source)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(contents)
	localSHA := hex.EncodeToString(digest[:])
	if expectedSHA != "" && localSHA != expectedSHA {
		return errors.New("downloaded bytes do not match the requested SHA-256")
	}
	if err := creator.CreateBinaryFile(ctx, plan.InstanceRef, target, contents); err != nil {
		return fmt.Errorf("create downloaded file: %w", err)
	}
	readBack, err := reader.ReadBinaryFile(ctx, plan.InstanceRef, target)
	if err != nil {
		return fmt.Errorf("download write completed without byte-exact readback: %w", err)
	}
	readBackDigest := sha256.Sum256(readBack)
	if len(readBack) != len(contents) || readBackDigest != digest {
		return errors.New("download write completed but byte-exact readback did not match")
	}
	after, err := lister.ListFileEntries(ctx, plan.InstanceRef, parent)
	if err != nil || after.Truncated || !containsExactFileName(after.Names, name) {
		return errors.New("download write completed without exact directory evidence")
	}
	sourceDigest := sha256.Sum256([]byte(source))
	observed := map[string]any{
		"schema_version": "file-download-result/v1", "target": target,
		"size_bytes": len(contents), "sha256": localSHA,
		"source_url_sha256": hex.EncodeToString(sourceDigest[:]), "created": true,
	}
	summary := fmt.Sprintf("Created %s from a public download (%d bytes, sha256:%s)", target, len(contents), localSHA)
	emit("", "download", summary, observed)
	emit("", "verification.download", "Byte-exact download readback verified", observed)
	if e.audit != nil {
		e.audit.Append("file.download.created", plan.TaskID, target, map[string]any{
			"size_bytes": len(contents), "sha256": localSHA,
			"source_url_sha256": hex.EncodeToString(sourceDigest[:]),
		})
	}
	return nil
}

func validatedFileDownloadArgs(args map[string]any) (string, string, string, error) {
	if len(args) < 2 || len(args) > 3 {
		return "", "", "", errors.New("file.download accepts url, target, and optional sha256 only")
	}
	for key := range args {
		if key != "url" && key != "target" && key != "sha256" {
			return "", "", "", errors.New("file.download received an unknown argument")
		}
	}
	source, sourceOK := args["url"].(string)
	target, targetOK := args["target"].(string)
	if !sourceOK || !targetOK {
		return "", "", "", errors.New("file.download requires string url and target arguments")
	}
	parsed, err := url.Parse(source)
	if err != nil || validatePublicDownloadURL(parsed) != nil || len(source) > 2048 || parsed.String() != source {
		return "", "", "", errors.New("download URL must be canonical public HTTP(S)")
	}
	target, err = normalizeDownloadTarget(target)
	if err != nil {
		return "", "", "", err
	}
	expectedSHA := ""
	if raw, exists := args["sha256"]; exists {
		value, ok := raw.(string)
		if !ok || len(value) != 64 || value != strings.ToLower(value) {
			return "", "", "", errors.New("file.download sha256 must be 64 lowercase hexadecimal characters")
		}
		if _, err := hex.DecodeString(value); err != nil {
			return "", "", "", errors.New("file.download sha256 must be 64 lowercase hexadecimal characters")
		}
		expectedSHA = value
	}
	return source, target, expectedSHA, nil
}

func normalizeDownloadTarget(raw string) (string, error) {
	if raw == "" || len(raw) > 170 || strings.HasPrefix(raw, "/") || strings.HasSuffix(raw, "/") || strings.Contains(raw, "\\") || strings.Contains(raw, ":") {
		return "", errors.New("download target must be one new downloads/<filename> path")
	}
	clean := path.Clean(raw)
	segments := strings.Split(clean, "/")
	if clean != raw || len(segments) != 2 || segments[0] != "downloads" {
		return "", errors.New("download target must be one new downloads/<filename> path")
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || len(segment) > 160 || strings.TrimSpace(segment) == "" || strings.ContainsAny(segment, "<>\"|?*;\x00\r\n") {
			return "", errors.New("download target must be one new downloads/<filename> path")
		}
	}
	return clean, nil
}

func containsExactFileName(names []string, expected string) bool {
	for _, name := range names {
		if name == expected {
			return true
		}
	}
	return false
}

func validatePublicDownloadURL(candidate *url.URL) error {
	if candidate == nil || (candidate.Scheme != "http" && candidate.Scheme != "https") || candidate.Host == "" || candidate.User != nil || candidate.Fragment != "" {
		return errors.New("download URL must be public HTTP(S) without credentials or fragments")
	}
	host := strings.TrimSuffix(candidate.Hostname(), ".")
	if host == "" || strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return errors.New("download URL host is not public")
	}
	if literal := net.ParseIP(host); literal != nil && !isPublicInternetIP(literal) {
		return errors.New("download URL host is not public")
	}
	return nil
}

func publicInternetDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("download destination address is invalid")
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("download destination did not resolve")
	}
	for _, address := range addresses {
		if !isPublicInternetIP(address.IP) {
			return nil, errors.New("download destination resolved outside the public internet")
		}
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	return dialer.DialContext(ctx, network, net.JoinHostPort(addresses[0].IP.String(), port))
}

var nonPublicInternetPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"), netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"), netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"), netip.MustParsePrefix("2001:db8::/32"),
}

func isPublicInternetIP(ip net.IP) bool {
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() {
		return false
	}
	for _, prefix := range nonPublicInternetPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}
