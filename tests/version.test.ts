import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("is the version package.json declares", () => {
    // The report header and the config hash print VERSION. The release tag,
    // the tarball names and the formula read package.json. A release PR bumps
    // both, and this holds them together.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
