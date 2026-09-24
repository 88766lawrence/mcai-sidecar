import type { AgentLoopObservation } from "../chat/agent-loop";

const downloadResultKeys = [
  "created", "schema_version", "sha256", "size_bytes", "source_url_sha256", "target",
];
const lowercaseSha256 = /^[a-f0-9]{64}$/u;

/**
 * Narrow fail-closed fallback for one completed file.download call. The
 * producer result has already been bound to the current Task requirements by
 * TasksService; this renderer independently requires its create and byte-exact
 * readback projections to agree before exposing target, size and checksum.
 */
export function renderVerifiedFileDownloadFinal(
  message: string,
  observations: AgentLoopObservation[],
): string | undefined {
  if (observations.length !== 1) return undefined;
  const observation = observations[0]!;
  if (observation.tool !== "file.download" || observation.status !== "succeeded"
    || observation.side_effect !== "applied" || observation.retryable !== false
    || !observation.tool_call_id) return undefined;
  const data = plainRecord(observation.data);
  if (!data || data.task_state !== "SUCCEEDED" || !Array.isArray(data.observations)
    || !data.observations.every((item) => Boolean(plainRecord(item)))) return undefined;
  const projected = data.observations as Record<string, unknown>[];
  const created = projected.filter((item) => item.kind === "download");
  const verified = projected.filter((item) => item.kind === "verification.download");
  if (created.length !== 1 || verified.length !== 1) return undefined;
  const creation = validatedEvidence(created[0]);
  const readback = validatedEvidence(verified[0]);
  if (!creation || !readback || creation.stepId !== readback.stepId
    || !sameDownloadResult(creation.result, readback.result)) return undefined;
  const result = creation.result;
  return /[\u3400-\u9fff]/u.test(message)
    ? `已下载并创建 ${result.target}：${result.size_bytes} 字节，SHA-256 ${result.sha256}。`
    : `Downloaded and created ${result.target}: ${result.size_bytes} bytes, SHA-256 ${result.sha256}.`;
}

function validatedEvidence(value: Record<string, unknown> | undefined) {
  if (!value || value.tool !== "file.download" || value.result !== "match"
    || typeof value.step_id !== "string" || !value.step_id) return undefined;
  const result = validatedDownloadResult(value.observed);
  return result ? { stepId: value.step_id, result } : undefined;
}

function validatedDownloadResult(value: unknown) {
  const result = plainRecord(value);
  if (!result || JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(downloadResultKeys)
    || result.schema_version !== "file-download-result/v1" || result.created !== true
    || !canonicalDownloadTarget(result.target)
    || !Number.isSafeInteger(result.size_bytes) || Number(result.size_bytes) < 1 || Number(result.size_bytes) > 64 * 1024 * 1024
    || typeof result.sha256 !== "string" || !lowercaseSha256.test(result.sha256)
    || typeof result.source_url_sha256 !== "string" || !lowercaseSha256.test(result.source_url_sha256)) return undefined;
  return result as {
    created: true;
    schema_version: "file-download-result/v1";
    sha256: string;
    size_bytes: number;
    source_url_sha256: string;
    target: string;
  };
}

function canonicalDownloadTarget(value: unknown) {
  if (typeof value !== "string" || value.length < 11 || value.length > 170 || /[\0-\x1f\x7f\\:]/u.test(value)) return undefined;
  const segments = value.split("/");
  if (segments.length !== 2 || segments[0] !== "downloads") return undefined;
  const fileName = segments[1];
  if (!fileName || fileName === "." || fileName === ".." || fileName.length > 160
    || fileName.trim() !== fileName || /[<>"|?*;]/u.test(fileName)) return undefined;
  return value;
}

function sameDownloadResult(
  left: NonNullable<ReturnType<typeof validatedDownloadResult>>,
  right: NonNullable<ReturnType<typeof validatedDownloadResult>>,
) {
  return left.schema_version === right.schema_version && left.created === right.created
    && left.target === right.target && left.size_bytes === right.size_bytes
    && left.sha256 === right.sha256 && left.source_url_sha256 === right.source_url_sha256;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
