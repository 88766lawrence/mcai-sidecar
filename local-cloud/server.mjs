import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { answerTaskWithSdk, providerConfigured, routeWithAgent, routeWithAgentStream } from "./agent.mjs";

const configPath = process.env.MCAI_MODEL_CONFIG ?? "/etc/mcai-model-cloud/config.json";
const maxBodyBytes = 64 * 1024;

function send(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function beginStream(response) {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
}

function writeStream(response, event) {
  if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
}

async function loadConfig() {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function authorized(request, token) {
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(actual);
  const right = Buffer.from(token ?? "");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const initialConfig = await loadConfig().catch(() => ({
  listenHost: "127.0.0.1",
  listenPort: 4200,
  serviceToken: "",
  provider: {},
}));

const server = createServer(async (request, response) => {
  try {
    const config = await loadConfig();
    if (request.method === "GET" && request.url === "/health") {
      return send(response, 200, {
        status: "ok",
        configured: providerConfigured(config),
        runtime: "vercel-ai-sdk",
      });
    }
    if (request.method !== "POST" || !["/v1/respond", "/v1/chat", "/v1/chat/stream"].includes(request.url ?? "")) {
      return send(response, 404, { error: "NOT_FOUND" });
    }
    if (!authorized(request, config.serviceToken)) return send(response, 401, { error: "UNAUTHORIZED" });
    const payload = await readJson(request);
    if (request.url === "/v1/chat" || request.url === "/v1/chat/stream") {
      if (!payload?.message || typeof payload.message !== "string") {
        return send(response, 400, { error: "INVALID_MESSAGE" });
      }
      if (request.url === "/v1/chat/stream") {
        beginStream(response);
        const decision = await routeWithAgentStream(config, payload, (event) => writeStream(response, event));
        writeStream(response, { type: "done", decision });
        return response.end();
      }
      return send(response, 200, await routeWithAgent(config, payload));
    }
    if (!payload?.intent || typeof payload.intent !== "string") {
      return send(response, 400, { error: "INVALID_INTENT" });
    }
    return send(response, 200, await answerTaskWithSdk(config, payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[model-cloud] request failed:", message);
    if (response.headersSent) {
      writeStream(response, { type: "error", message });
      return response.end();
    }
    return send(response, message === "REQUEST_TOO_LARGE" ? 413 : 502, { error: message });
  }
});

server.listen(
  Number(initialConfig.listenPort ?? 4200),
  String(initialConfig.listenHost ?? "127.0.0.1"),
  () => console.log(`MCAI local model cloud listening on ${initialConfig.listenHost ?? "127.0.0.1"}:${initialConfig.listenPort ?? 4200}`),
);
