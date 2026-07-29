import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupService } from "./setup.service";

describe("SetupService", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mcai-setup-"));
    process.env.MCAI_CONFIG_DIR = directory;
    process.env.MCAI_AGENT_CONFIG_DIR = directory;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 200,
      data: [{ uuid: "daemon_test" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.MCAI_CONFIG_DIR;
    delete process.env.MCAI_AGENT_CONFIG_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("persists setup, keeps the API key out of the account record, and authenticates the admin", async () => {
    const service = new SetupService();
    const result = await service.configure({
      username: "admin",
      password: "correct-horse-battery",
      endpoint: "http://127.0.0.1:23333",
      apiKey: "test-api-key-123456789",
    });

    expect(result).toMatchObject({ configured: true, daemonCount: 1 });
    const [requestUrl, requestInit] = vi.mocked(fetch).mock.calls[0];
    expect(requestUrl.toString()).toContain("/api/service/remote_services_list?apikey=");
    expect(requestInit?.headers).toMatchObject({ "x-requested-with": "xmlhttprequest" });
    expect(await service.status()).toMatchObject({ configured: true, username: "admin" });
    expect(await readFile(join(directory, "setup.json"), "utf8")).not.toContain("test-api-key");
    expect(await readFile(join(directory, "credentials.yaml"), "utf8")).toContain("test-api-key");

    await expect(service.login("admin", "wrong-password")).rejects.toThrow("账号或密码错误");
    const session = await service.login("admin", "correct-horse-battery");
    await expect(service.verify(session.token)).resolves.toMatchObject({ sub: "admin", tenantId: "tenant_local" });
  });
});
