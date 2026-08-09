import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { emptyConfig, fixtureConfig, solutionConfig } from "./helpers.js";

/**
 * The CLI's contract with a harness is its exit code, so every case here
 * asserts the code first and the message second. Streams are captured rather
 * than silenced so a regression that stops explaining itself is caught too.
 */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { stdout: () => out.join(""), stderr: () => err.join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("main", () => {
  it("exits 0 and prints a report for a config with source files", async () => {
    const io = capture();
    expect(await main(["--config", fixtureConfig()])).toBe(0);
    expect(io.stdout()).toContain("# thicket report");
  });

  it("exits non-zero when the project has no source files", async () => {
    const io = capture();
    expect(await main(["--config", emptyConfig()])).not.toBe(0);
    expect(io.stdout()).not.toContain("# thicket report");
    expect(io.stderr()).toMatch(/no source files/i);
  });

  it("names the config and the likely cause when the project is empty", async () => {
    const io = capture();
    await main(["--config", emptyConfig()]);
    expect(io.stderr()).toContain("fixtures/empty/tsconfig.json");
    expect(io.stderr()).toMatch(/references|include/i);
  });

  it("rejects an empty --config instead of silently analyzing the cwd", async () => {
    const io = capture();
    expect(await main(["--config", ""])).not.toBe(0);
    expect(io.stderr()).toMatch(/--config/);
    expect(io.stdout()).toBe("");
  });

  it("exits non-zero for a nonexistent config path", async () => {
    const io = capture();
    expect(await main(["--config", "/definitely/not/here/tsconfig.json"])).not.toBe(0);
    expect(io.stderr()).toContain("/definitely/not/here/tsconfig.json");
    expect(io.stdout()).toBe("");
  });

  it("analyzes a solution-style config rather than reporting it empty", async () => {
    const io = capture();
    expect(await main(["--config", solutionConfig()])).toBe(0);
    expect(io.stdout()).toMatch(/3 files/);
  });
});
