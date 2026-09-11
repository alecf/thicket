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
function runBun(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bun", args, { cwd: repoRoot });
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
    const { code, out } = await runBun(
      ["src/cli.ts", "--config", fixtureConfig(), "--no-cache"],
      60_000,
    );
    expect(code).toBe(0);
    expect(out).toContain("# thicket report");
  }, 70_000);

  // `sourceFileNames` opens an API of its own, so it can strand a `tsgo` child
  // the same way -- and nothing in its ANSWER would show it. No CLI flag
  // reaches the probe yet, so the run is a one-line script rather than an
  // argument; in-process it would prove nothing, because vitest's own worker
  // tears the connection down at exit.
  it("exits on its own after a probe, which opens a second API", async () => {
    const { code, out } = await runBun(
      [
        "-e",
        `const { sourceFileNames } = await import("./src/extract/ts-adapter.ts");\n` +
          `console.log(JSON.stringify((await sourceFileNames([${JSON.stringify(fixtureConfig())}])).names));\n`,
      ],
      60_000,
    );
    expect(code).toBe(0);
    // The exact list, so a probe that hangs is distinguishable from one that
    // exits promptly having found nothing.
    expect(JSON.parse(out)).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
      "src/gamma.ts",
      "src/util/shared.ts",
    ]);
  }, 70_000);
});
