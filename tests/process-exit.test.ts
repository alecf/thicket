import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureConfig } from "./helpers.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every other CLI test calls `main()` in process, which cannot see the one
 * failure mode this file exists for: the report is printed, correct and
 * complete, and then the process never exits.
 *
 * The TypeScript API holds an open connection to the `tsgo` child it spawned.
 * Under the sync API that child was unref'd and the process ended on its own;
 * the async API's connection keeps the event loop alive, so forgetting to
 * close it costs nothing visible in the output and hangs every harness that
 * waits for the command to finish. Only a real subprocess can prove otherwise.
 */
function runCli(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bun", ["src/cli.ts", ...args], { cwd: repoRoot });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`thicket did not exit within ${timeoutMs}ms; it printed ${out.length} bytes`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out });
    });
  });
}

describe("the thicket process", () => {
  it("exits on its own once the report is written", async () => {
    const { code, out } = await runCli(["--config", fixtureConfig(), "--no-cache"], 60_000);
    expect(code).toBe(0);
    expect(out).toContain("# thicket report");
  }, 70_000);
});
