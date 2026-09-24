package provider

import "context"

type Instance struct {
	Ref              string  `json:"instance_id"`
	Name             string  `json:"name"`
	Platform         string  `json:"platform"`
	MinecraftVersion string  `json:"minecraft_version"`
	State            string  `json:"state"`
	Loader           string  `json:"loader,omitempty"`
	ProfileRevision  string  `json:"profile_revision"`
	ProviderType     string  `json:"provider_type"`
	CollectedAt      string  `json:"collected_at"`
	MemoryBytes      int64   `json:"memory_bytes,omitempty"`
	MemoryLimitBytes int64   `json:"memory_limit_bytes,omitempty"`
	CPUUsage         float64 `json:"cpu_usage,omitempty"`
	UptimeSeconds    int64   `json:"uptime_seconds,omitempty"`
}

// StartConfig is the small, explicit subset of an instance configuration the
// installer is allowed to change. Providers must preserve all other settings.
type StartConfig struct {
	StartCommand string
	StopCommand  string
	StopTimeout  int
}

// FileListing is the lossless, bounded directory result returned by a
// provider. Display strings are deliberately not parsed back into facts.
type FileListing struct {
	Names     []string `json:"names"`
	Total     int      `json:"total"`
	Truncated bool     `json:"truncated"`
}

type StructuredFileLister interface {
	ListFileEntries(context.Context, string, string) (FileListing, error)
}

type BinaryFileReader interface {
	ReadBinaryFile(context.Context, string, string) ([]byte, error)
}

// BinaryFileCreator creates exactly one binary file without replacing an
// existing target. Implementations either commit all bytes at the exact path
// or return an error.
type BinaryFileCreator interface {
	CreateBinaryFile(context.Context, string, string, []byte) error
}

type Provider interface {
	ListInstances(context.Context) ([]Instance, error)
	ReadOutput(context.Context, string, int) (string, error)
	ListFiles(context.Context, string, string) (string, error)
	DownloadFromURL(context.Context, string, string, string) error
	UpdateStartConfig(context.Context, string, StartConfig) error
	ReadFile(context.Context, string, string) ([]byte, error)
	WriteFile(context.Context, string, string, []byte) error
	SendCommand(context.Context, string, string) error
	Start(context.Context, string) error
	Stop(context.Context, string) error
	Restart(context.Context, string) error
	GetInstance(context.Context, string) (Instance, error)
}
