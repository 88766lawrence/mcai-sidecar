import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const tenantId = "tenant_local";

interface SetupRecord {
  version: 1;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  admins?: AdminAccount[];
  authSecret: string;
  tenantId: string;
  configuredAt: string;
}

interface AdminAccount {
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
}

interface SessionPayload {
  sub: string;
  tenantId: string;
  exp: number;
}

export interface SetupInput {
  username?: string;
  password?: string;
  endpoint?: string;
  apiKey?: string;
}

@Injectable()
export class SetupService {
  private readonly configDir = resolve(process.env.MCAI_CONFIG_DIR ?? join(process.cwd(), ".data", "mcai"));
  private readonly agentConfigDir = resolve(process.env.MCAI_AGENT_CONFIG_DIR ?? join(this.configDir, "agent"));
  private readonly recordPath = join(this.configDir, "setup.json");

  async status() {
    const record = await this.readRecord();
    return {
      configured: Boolean(record),
      username: record?.username,
      adminCount: record ? this.accounts(record).length : 0,
      configuredAt: record?.configuredAt,
    };
  }

  async configure(input: SetupInput) {
    if (await this.readRecord()) throw new BadRequestException("系统已经完成初始化");
    const username = input.username?.trim() ?? "";
    const password = input.password ?? "";
    const apiKey = input.apiKey?.trim() ?? "";
    const endpoint = this.validateEndpoint(input.endpoint ?? "");
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new BadRequestException("管理员账号需为 3-32 位字母、数字或 ._-");
    if (password.length < 10) throw new BadRequestException("管理员密码至少需要 10 位");
    if (apiKey.length < 16 || apiKey.length > 256) throw new BadRequestException("API Key 格式不正确");

    const daemonIds = await this.discoverDaemons(endpoint, apiKey);
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    const record: SetupRecord = {
      version: 1,
      username,
      passwordSalt: salt.toString("base64"),
      passwordHash: hash.toString("base64"),
      authSecret: randomBytes(32).toString("base64"),
      tenantId,
      configuredAt: new Date().toISOString(),
    };

    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await mkdir(this.agentConfigDir, { recursive: true, mode: 0o700 });
    await this.writePrivate(this.recordPath, JSON.stringify(record, null, 2));
    await this.writePrivate(join(this.agentConfigDir, "agent.yaml"), this.agentConfig(endpoint, daemonIds));
    await this.writePrivate(join(this.agentConfigDir, "credentials.yaml"), this.credentials(apiKey));

    let agentStarted = false;
    if (process.platform === "linux") {
      try {
        await run("systemctl", ["enable", "--now", "mcai-agent.service"], { timeout: 15_000 });
        await run("systemctl", ["restart", "mcai-agent.service"], { timeout: 15_000 });
        agentStarted = true;
      } catch {
        agentStarted = false;
      }
    }
    return { configured: true, username, daemonCount: daemonIds.length, agentStarted };
  }

  async login(usernameInput: string, password: string) {
    const record = await this.readRecord();
    if (!record) throw new BadRequestException("系统尚未初始化");
    const username = usernameInput.trim();
    const account = this.accounts(record).find((candidate) => candidate.username === username);
    if (!account) throw new UnauthorizedException("账号或密码错误");
    const actual = scryptSync(password, Buffer.from(account.passwordSalt, "base64"), 64);
    const expected = Buffer.from(account.passwordHash, "base64");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException("账号或密码错误");
    }
    const payload: SessionPayload = { sub: account.username, tenantId: record.tenantId, exp: Date.now() + 12 * 60 * 60_000 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = this.sign(encoded, record.authSecret);
    return { token: `${encoded}.${signature}`, expiresAt: new Date(payload.exp).toISOString(), username: account.username };
  }

  async createAdmin(input: { username?: string; password?: string }) {
    const record = await this.readRecord();
    if (!record) throw new BadRequestException("系统尚未初始化");
    const username = input.username?.trim() ?? "";
    const password = input.password ?? "";
    this.validateAccount(username, password);
    if (this.accounts(record).some((account) => account.username === username)) {
      throw new BadRequestException("管理员账号已经存在");
    }
    const account = this.createAccount(username, password);
    record.admins = [...(record.admins ?? []), account];
    await this.writePrivate(this.recordPath, JSON.stringify(record, null, 2));
    return { username: account.username, createdAt: account.createdAt, adminCount: this.accounts(record).length };
  }

  async verify(token: string): Promise<SessionPayload> {
    const record = await this.readRecord();
    if (!record) throw new UnauthorizedException("系统尚未初始化");
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) throw new UnauthorizedException("登录已失效");
    const expected = this.sign(encoded, record.authSecret);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      throw new UnauthorizedException("登录已失效");
    }
    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    } catch {
      throw new UnauthorizedException("登录已失效");
    }
    const accountExists = this.accounts(record).some((account) => account.username === payload.sub);
    if (payload.exp <= Date.now() || !accountExists || payload.tenantId !== record.tenantId) {
      throw new UnauthorizedException("登录已过期");
    }
    return payload;
  }

  private validateEndpoint(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException("MCSManager 地址无效");
    }
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new BadRequestException("MCSManager 必须使用 HTTPS；本机地址可使用 HTTP");
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  private async discoverDaemons(endpoint: string, apiKey: string) {
    const url = new URL("/api/service/remote_services_list", endpoint);
    url.searchParams.set("apikey", apiKey);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-requested-with": "xmlhttprequest",
        },
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new BadRequestException("无法连接 MCSManager，请检查地址");
    }
    const body = await response.json().catch(() => null) as {
      status?: number;
      data?: Array<{ uuid?: string; id?: string; daemonId?: string }>;
    } | null;
    if (!response.ok || body?.status !== 200) throw new BadRequestException("API Key 验证失败或权限不足");
    const ids = (body.data ?? []).map((item) => item.uuid ?? item.daemonId ?? item.id ?? "").filter(Boolean);
    if (!ids.length) throw new BadRequestException("API Key 有效，但没有发现可管理的 Daemon 节点");
    return [...new Set(ids)];
  }

  private agentConfig(endpoint: string, daemonIds: string[]) {
    const daemonYaml = daemonIds.map((id) => `      - ${JSON.stringify(id)}`).join("\n");
    return `cloud:
  gateway_url: "ws://127.0.0.1:4100/agent"
  tenant_id: "${tenantId}"
data_dir: "/var/lib/mcai-agent"
display_name: ${JSON.stringify(`MCAI Agent · ${hostname()}`)}
inventory_interval: "30s"
providers:
  - id: "local-mcs"
    type: "mcsmanager"
    endpoint: ${JSON.stringify(endpoint)}
    daemon_ids:
${daemonYaml}
`;
  }

  private credentials(apiKey: string) {
    return `providers:
  local-mcs:
    api_key: ${JSON.stringify(apiKey)}
`;
  }

  private async readRecord(): Promise<SetupRecord | null> {
    try {
      return JSON.parse(await readFile(this.recordPath, "utf8")) as SetupRecord;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  private async writePrivate(path: string, contents: string) {
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  }

  private validateAccount(username: string, password: string) {
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new BadRequestException("管理员账号需为 3-32 位字母、数字或 ._-");
    if (password.length < 10) throw new BadRequestException("管理员密码至少需要 10 位");
  }

  private createAccount(username: string, password: string): AdminAccount {
    const salt = randomBytes(16);
    return {
      username,
      passwordSalt: salt.toString("base64"),
      passwordHash: scryptSync(password, salt, 64).toString("base64"),
      createdAt: new Date().toISOString(),
    };
  }

  private accounts(record: SetupRecord): AdminAccount[] {
    const primary: AdminAccount = {
      username: record.username,
      passwordSalt: record.passwordSalt,
      passwordHash: record.passwordHash,
      createdAt: record.configuredAt,
    };
    return [primary, ...(record.admins ?? []).filter((account) => account.username !== record.username)];
  }

  private sign(encoded: string, secret: string) {
    return createHmac("sha256", Buffer.from(secret, "base64")).update(encoded).digest("base64url");
  }
}
