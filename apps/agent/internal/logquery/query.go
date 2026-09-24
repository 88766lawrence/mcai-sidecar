package logquery

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
)

type Group struct {
	AllOf []string `json:"all_of"`
	AnyOf []string `json:"any_of"`
}

type Query struct {
	SchemaVersion string  `json:"schema_version"`
	Groups        []Group `json:"groups"`
	Digest        string  `json:"digest"`
}

type digestShape struct {
	SchemaVersion string  `json:"schema_version"`
	Groups        []Group `json:"groups"`
}

var subjectTokens = map[string]bool{"client_connection": true, "http_request": true, "backup": true, "world_save": true, "software_component": true, "database_service": true, "proxy_service": true, "server_lag": true, "memory_resource": true, "world_storage": true}

var terms = map[string][]string{
	"all":                    {""},
	"client_connection":      {"player", "client", "user authenticator", "login", "logged in", "joined", "join", "connection", "connect", "handshake", "玩家", "客户端", "用户", "登录", "加入", "连接", "握手"},
	"http_request":           {"http", "api", "webhook", "request", "接口"},
	"backup":                 {"backup", "snapshot", "备份", "快照"},
	"world_save":             {"world save", "saving world", "chunk save", "save chunk", "保存世界", "区块保存", "存档"},
	"software_component":     {"plugin", "extension", "module", "component", "loader", "插件", "扩展", "模块", "组件", "加载器"},
	"database_service":       {"database", "datasource", "sql", "mysql", "postgres", "postgresql", "redis", "数据库", "数据源"},
	"proxy_service":          {"proxy", "gateway", "reverse proxy", "代理", "网关", "反向代理"},
	"server_lag":             {"can't keep up", "cannot keep up", "server is behind", "running behind", "tick took", "服务器跟不上", "服务端跟不上", "卡顿"},
	"memory_resource":        {"memory", "heap", "outofmemory", "gc overhead", "garbage collection", "内存", "堆空间", "垃圾回收"},
	"world_storage":          {"world", "chunk", "region", "level", "storage", "世界", "区块", "区域文件", "存档"},
	"authentication_failure": {"authentication failed", "login failed", "failed to authenticate", "认证失败", "鉴权失败", "登录失败"},
	"connection_failure":     {"connection failed", "failed to connect", "connection refused", "handshake failed", "login failed", "连接失败", "拒绝连接", "握手失败", "登录失败"},
	"timeout":                {"timeout", "timed out", "timed-out", "超时"},
	"resource_failure":       {"resource pack failed", "download failed", "资源包下载失败", "下载失败"},
	"permission_failure":     {"permission denied", "access denied", "permission rejected", "权限被拒", "权限拒绝", "权限不足", "拒绝访问"},
	"disconnect":             {"disconnected", "disconnect", "connection closed", "断开连接", "掉线"},
	"warning":                {"warn", "warning", "警告"},
	"crash":                  {"crash", "fatal", "崩溃", "崩服"},
	"error":                  {"error", "exception", "错误", "报错"},
	"initialization_failure": {"failed to load", "load failed", "failed to initialize", "initialization failed", "unable to initialize", "startup failed", "could not enable", "加载失败", "初始化失败", "启动失败", "无法加载", "无法初始化"},
	"dependency_missing":     {"missing dependency", "dependency missing", "dependency not found", "unsatisfied dependency", "required dependency", "dependencies unavailable", "依赖缺失", "缺少依赖", "未找到依赖", "依赖不满足"},
	"response_failure":       {"malformed response", "invalid response", "response error", "响应无效", "响应错误", "畸形响应"},
	"cannot_keep_up":         {"can't keep up", "cannot keep up", "running behind", "server is behind", "服务器跟不上", "服务端跟不上", "来不及处理"},
	"tick_timeout":           {"tick timeout", "tick timed out", "single tick took", "server tick took", "watchdog", "单个tick超时", "游戏刻超时"},
	"out_of_memory":          {"out of memory", "outofmemory", "memory allocation failed", "内存不足", "内存耗尽", "内存分配失败"},
	"heap_exhaustion":        {"java heap space", "heap space", "heap exhausted", "heap exhaustion", "堆空间耗尽", "堆空间不足"},
	"gc_overhead":            {"gc overhead limit exceeded", "gc overhead", "垃圾回收开销过高", "垃圾回收耗时过高"},
	"save_failure":           {"failed to save world", "world save failed", "unable to save level", "save failure", "世界保存失败", "存档保存失败"},
	"chunk_corruption":       {"chunk corrupted", "corrupt chunk", "region corrupted", "corrupt region", "区块损坏", "区域文件损坏"},
	"chunk_read_failure":     {"failed to read chunk", "chunk read failed", "unable to load chunk", "region read error", "区块读取失败", "区块读取异常", "区域文件读取失败"},
}

func Parse(args map[string]any, requireStructured bool) (Query, []string, error) {
	filters := stringList(args["filters"])
	raw, exists := args["filter_query"]
	if !exists {
		if requireStructured {
			return Query{}, nil, errors.New("logs.query requires a structured filter_query")
		}
		group := Group{AllOf: []string{"all"}, AnyOf: []string{}}
		if len(filters) == 1 {
			group = Group{AllOf: append([]string(nil), filters...), AnyOf: []string{}}
		} else if len(filters) > 1 {
			// Legacy direct executor callers used flat filters with OR semantics.
			// Runtime plans must use the structured query and never take this path.
			group = Group{AllOf: []string{}, AnyOf: append([]string(nil), filters...)}
		}
		query := New([]Group{group})
		return query, filters, nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return Query{}, nil, errors.New("logs.query filter_query is malformed")
	}
	var query Query
	if err := json.Unmarshal(encoded, &query); err != nil {
		return Query{}, nil, errors.New("logs.query filter_query is malformed")
	}
	if err := Validate(query); err != nil {
		return Query{}, nil, err
	}
	if !sameStrings(filters, EventFilters(query)) {
		return Query{}, nil, errors.New("logs.query filters do not match filter_query")
	}
	return query, filters, nil
}

func New(groups []Group) Query {
	query := Query{SchemaVersion: "log-filter-query/v1", Groups: groups}
	query.Digest = digest(query)
	return query
}

func Validate(query Query) error {
	if query.SchemaVersion != "log-filter-query/v1" || len(query.Groups) < 1 || len(query.Groups) > 4 {
		return errors.New("logs.query filter_query envelope is invalid")
	}
	for _, group := range query.Groups {
		if len(group.AllOf)+len(group.AnyOf) < 1 || len(group.AllOf)+len(group.AnyOf) > 8 {
			return errors.New("logs.query filter group is invalid")
		}
		seen := map[string]bool{}
		for _, token := range append(append([]string{}, group.AllOf...), group.AnyOf...) {
			if seen[token] || !validToken(token) {
				return errors.New("logs.query filter condition is duplicated or unknown")
			}
			seen[token] = true
		}
	}
	if query.Digest != digest(query) {
		return errors.New("logs.query filter_query digest mismatch")
	}
	return nil
}

func Match(line string, query Query) bool {
	if Validate(query) != nil {
		return false
	}
	for _, group := range query.Groups {
		all := true
		for _, token := range group.AllOf {
			if !condition(line, token) {
				all = false
				break
			}
		}
		if !all {
			continue
		}
		if len(group.AnyOf) == 0 {
			return true
		}
		for _, token := range group.AnyOf {
			if condition(line, token) {
				return true
			}
		}
	}
	return false
}

func EventFilters(query Query) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, group := range query.Groups {
		for _, token := range append(append([]string{}, group.AllOf...), group.AnyOf...) {
			if subjectTokens[token] || token == "all" || seen[token] {
				continue
			}
			seen[token] = true
			result = append(result, token)
		}
	}
	return result
}

func condition(line, token string) bool {
	if token == "all" {
		return true
	}
	values := terms[token]
	if strings.HasPrefix(token, "literal:") {
		values = []string{strings.TrimPrefix(token, "literal:")}
	}
	lower := strings.ToLower(line)
	for _, value := range values {
		if strings.Contains(lower, strings.ToLower(value)) {
			return true
		}
	}
	return false
}

func validToken(token string) bool {
	if _, ok := terms[token]; ok {
		return true
	}
	if !strings.HasPrefix(token, "literal:") || len([]rune(token)) <= len([]rune("literal:")) || len([]rune(token)) > 64 {
		return false
	}
	return strings.IndexFunc(token, unicode.IsControl) < 0
}

func digest(query Query) string {
	encoded, _ := json.Marshal(digestShape{SchemaVersion: query.SchemaVersion, Groups: query.Groups})
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func stringList(value any) []string {
	result := []string{}
	switch values := value.(type) {
	case []string:
		return append(result, values...)
	case []any:
		for _, item := range values {
			text, ok := item.(string)
			if ok {
				result = append(result, text)
			}
		}
	}
	return result
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
