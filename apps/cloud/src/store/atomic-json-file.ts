import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Serializes snapshots and atomically replaces the durable JSON file. */
export class AtomicJsonFile {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  write(value: unknown) {
    let contents: string;
    try {
      contents = `${JSON.stringify(value, null, 2)}\n`;
    } catch (cause) {
      return Promise.reject(cause);
    }
    const operation = this.queue.then(() => this.replace(contents));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async replace(contents: string) {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporary, this.path);
          break;
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          if (attempt >= 7 || !["EACCES", "EBUSY", "EPERM"].includes(code ?? "")) throw cause;
          await delay(5 * (attempt + 1));
        }
      }
      if (process.platform !== "win32") {
        const directoryHandle = await open(directory, "r");
        try { await directoryHandle.sync(); }
        finally { await directoryHandle.close(); }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
