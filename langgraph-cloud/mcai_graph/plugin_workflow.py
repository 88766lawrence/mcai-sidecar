"""One evidence-driven install/activate/verify sequence for any Bukkit plugin."""
from __future__ import annotations

import re
from typing import Any


INSTALL_REQUEST = re.compile(r"安装|装上|给.{0,16}装|部署|更新|升级|帮我安排|\binstall\b|\bdeploy\b|\bupdate\b", re.I)
INSTALL_PROHIBITED = re.compile(r"(?:不要|无需|不必|禁止|别|仅|只)[^，。；;\r\n]{0,16}(?:安装|装|部署|更新|升级)|(?:do not|don't|without)\s+install", re.I)
ACTIVATION_PROHIBITED = re.compile(r"(?:不要|别|无需|不必|禁止)[^，。；;\r\n]{0,16}(?:重启|启动|生效)|(?:do not|don't|without)\s+(?:restart|start)", re.I)
MULTIPLE_PLUGINS = re.compile(r"同时|以及|\b(?:and|both)\b|(?:和|与|、|，|,)\s*[A-Za-z][A-Za-z0-9_-]{1,63}", re.I)


def arguments(item: dict[str, Any]) -> dict[str, Any]:
    data = item.get("data")
    value = data.get("call_arguments") if isinstance(data, dict) else None
    return value if isinstance(value, dict) else {}


def result(item: dict[str, Any], schema: str) -> dict[str, Any] | None:
    data = item.get("data")
    if not isinstance(data, dict):
        return None
    for fact in data.get("observations", []):
        value = fact.get("observed") if isinstance(fact, dict) else None
        if isinstance(value, dict) and (value.get("schema_version") == schema or
                schema == "resolved-plugin/v1" and "schema_version" not in value and value.get("resolution")):
            return value
    return None


def plugin_outcome_summary(message: str, observations: list[dict[str, Any]]) -> str | None:
    """Summarize observed projects, including blocked and unfinished work, without claiming the whole request succeeded."""
    if not INSTALL_REQUEST.search(message) or INSTALL_PROHIBITED.search(message):
        return None
    projects: dict[str, dict[str, Any]] = {}
    for item in observations:
        if item.get("tool") not in {"plugin.resolve", "plugin.install"}:
            continue
        project = str(arguments(item).get("project") or "").lower()
        if not project or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", project):
            continue
        facts = projects.setdefault(project, {})
        if item.get("tool") == "plugin.install" and item.get("status") == "succeeded":
            installed = result(item, "plugin-install-result/v1")
            if installed:
                facts["installed"] = installed
        elif item.get("tool") == "plugin.resolve":
            resolved = result(item, "resolved-plugin/v1")
            if resolved:
                facts["resolved"] = resolved
    lines = []
    for project, facts in projects.items():
        installed, resolved = facts.get("installed"), facts.get("resolved", {})
        if installed:
            if installed.get("already_present") is True:
                lines.append(f"{project}：已有文件与请求制品校验一致，无需重复安装或重启；这不代表本轮重新核验了加载状态。")
            else:
                project_observations = [item for item in observations if item.get("tool") != "plugin.install"
                                        or str(arguments(item).get("project") or "").lower() == project]
                verification = next_plugin_decision("安装 " + project, [], project_observations, {})
                lines.append(verification[0]["answer"] if verification and verification[0].get("action") == "final"
                             else f"{project}：插件文件已安装；尚未确认完成启动和实际加载核验。")
        elif resolved.get("resolution") in {"no-compatible-artifact", "search-incomplete", "query-failed"}:
            version = str(resolved.get("requested_minecraft_version") or "")
            sources = resolved.get("checked_sources")
            source_text = "、".join(str(s) for s in sources) if isinstance(sources, list) and sources else str(resolved.get("checked_source") or "已检查来源")
            reason = {"no-compatible-artifact": f"在 {source_text} 未找到适用于目标 Minecraft {version} 的兼容制品",
                      "search-incomplete": "历史版本查询达到上限，查询不完整，不能判定不存在兼容版本",
                      "query-failed": "来源查询或制品校验失败，不能判定兼容版本是否存在"}[resolved["resolution"]]
            lines.append(f"{project}：未安装；{reason}。")
        elif resolved:
            lines.append(f"{project}：已找到制品，但没有本轮安装成功的证据。")
    return "已核对的插件结果：\n" + "\n".join(lines) if lines else None


def finalize_plugin_decision(decision: dict[str, Any], message: str, observations: list[dict[str, Any]]) -> dict[str, Any]:
    if decision.get("action") != "final":
        return decision
    installed = {str(arguments(item).get("project") or "").lower() for item in observations
                 if item.get("tool") == "plugin.install" and item.get("status") == "succeeded"}
    blocked = any(str(arguments(item).get("project") or "").lower() not in installed and result(item, "resolved-plugin/v1") and
                  result(item, "resolved-plugin/v1").get("resolution") in {"no-compatible-artifact", "search-incomplete", "query-failed"}
                  for item in observations if item.get("tool") == "plugin.resolve")
    summary = plugin_outcome_summary(message, observations) if blocked else None
    return {**decision, "answer": summary} if summary else decision


def _call(tool: str, args: dict[str, Any], reason: str, label: str):
    return {"action": "tool_call", "tool": tool, "arguments": args, "reason": reason}, label


def _final(answer: str, observations: list[dict[str, Any]], label: str):
    citations = list(dict.fromkeys(item["tool_call_id"] for item in observations
                                  if item.get("status") == "succeeded" and isinstance(item.get("tool_call_id"), str)))
    return {"action": "final", "answer": answer, "citations": citations}, label


def next_plugin_decision(
    message: str, tools: list[dict[str, Any]], observations: list[dict[str, Any]], instance: dict[str, Any],
) -> tuple[dict[str, Any], str] | None:
    if not INSTALL_REQUEST.search(message) or INSTALL_PROHIBITED.search(message):
        return None
    names = {item["name"] for item in tools}
    installs = [(index, item) for index, item in enumerate(observations)
                if item.get("tool") == "plugin.install" and item.get("status") == "succeeded"]
    installed = {str(arguments(item).get("project") or "").lower() for _, item in installs}
    candidates = []
    if "plugin.install" in names:
        for item in observations:
            if item.get("tool") != "plugin.resolve" or item.get("status") != "succeeded":
                continue
            resolved = result(item, "resolved-plugin/v1")
            if resolved is None:
                continue
            project, artifact = str(resolved.get("project") or "").lower(), str(resolved.get("artifact") or "")
            if not project or project in installed or not artifact or not re.search(rf"\b{re.escape(project)}\b", message, re.I):
                continue
            sha256, sha512 = str(resolved.get("sha256") or "").lower(), str(resolved.get("source_sha512") or "").lower()
            integrity = ({"algorithm": "sha256", "value": sha256} if re.fullmatch(r"[a-f0-9]{64}", sha256)
                         else {"algorithm": "sha512", "value": sha512} if re.fullmatch(r"[a-f0-9]{128}", sha512) else None)
            if integrity and (item.get("data") or {}).get("task_id") and item.get("tool_call_id"):
                candidates.append({"project": project, "artifact_ref": artifact, "expected_integrity": integrity})
    if len(candidates) == 1:
        return _call("plugin.install", candidates[0], "已找到兼容制品，继续执行用户要求的插件安装。", "resolved-plugin-install")
    if len(installs) != 1 or MULTIPLE_PLUGINS.search(message):
        return None
    index, install = installs[0]
    args = arguments(install)
    project, artifact = str(args.get("project") or ""), str(args.get("artifact_ref") or "")
    if not project or not re.search(rf"(?<![A-Za-z0-9_-]){re.escape(project)}(?![A-Za-z0-9_-])", message, re.I):
        return None
    installed_result = result(install, "plugin-install-result/v1")
    if installed_result and installed_result.get("already_present") is True:
        path = installed_result.get("installed_path")
        if not isinstance(path, str) or not path.startswith("plugins/") or not re.fullmatch(r"[a-f0-9]{64}", str(installed_result.get("sha256") or "")):
            return None
        return _final(f"{path} 已是请求的插件制品，文件校验一致，无需重复安装。",
                      observations, "existing-plugin-artifact")
    lifecycle = [(offset, item) for offset, item in enumerate(observations[index + 1:], index + 1)
                 if item.get("tool") in {"instance.start", "instance.restart"}]
    if not lifecycle:
        if ACTIVATION_PROHIBITED.search(message):
            return None
        state = str(instance.get("state") or "").lower()
        tool = {"running": "instance.restart", "stopped": "instance.start"}.get(state)
        target = str(instance.get("id") or "")
        if tool in names and target:
            return _call(tool, {"target": target}, "插件文件已安装，申请启动服务端并核对实际加载结果。", "installed-plugin-activation")
        return None
    activation_index, activation = lifecycle[0]
    if activation.get("status") != "succeeded":
        return None
    later = observations[activation_index + 1:]
    files = next((item for item in later if item.get("tool") == "files.list"
                  and arguments(item).get("path") == "plugins"), None)
    if files is None:
        if "files.list" in names:
            return _call("files.list", {"path": "plugins", "suffix": ".jar"}, "启动后核对新版与旧版插件文件。", "plugin-activation-verification")
        return None
    if files.get("status") != "succeeded":
        return None
    console = next((item for item in later if item.get("tool") == "console.command"
                    and arguments(item).get("command") == "plugins"), None)
    if console is None:
        if "console.command" in names:
            return _call("console.command", {"command": "plugins"}, "核对运行时是否已加载目标插件。", "plugin-activation-verification")
        return None
    if console.get("status") != "succeeded" or not installed_result or not artifact:
        return None
    listing = result(files, "files-list-result/v1")
    inventory = result(console, "loaded-plugins-result/v1")
    if not listing or not inventory or listing.get("path") != "plugins" or listing.get("truncated") is not False:
        return None
    entries = [entry.get("name") for entry in listing.get("entries", []) if isinstance(entry, dict)]
    plugin_name = str(installed_result.get("plugin_name") or "")
    runtime_names = inventory.get("names")
    if not plugin_name or not isinstance(runtime_names, list) or inventory.get("total") != len(runtime_names):
        return None
    replaced = str(installed_result.get("replaces_path") or "").rsplit("/", 1)[-1]
    unique = entries.count(artifact) == 1 and (not replaced or replaced == artifact or replaced not in entries)
    loaded = any(str(name).lower() == plugin_name.lower() for name in runtime_names)
    verb = "启动" if activation.get("tool") == "instance.start" else "重启"
    file_fact = "新版 JAR 已存在且旧版已替换" if replaced and replaced != artifact else "插件 JAR 已存在"
    answer = (f"已安装 {plugin_name}（{artifact}）。实例{verb}后，{file_fact}，运行时插件列表确认已加载 {plugin_name}。"
              if unique and loaded else f"已执行 {project} 的安装和实例{verb}，但启动后核验未能同时确认新版文件与插件加载；本次不能判定安装完全生效。")
    return _final(answer, observations, "verified-plugin-activation")
