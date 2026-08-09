import { describe, expect, it } from "vitest";
import { GENERATED_DIR_SEGMENTS, isGeneratedPath } from "../src/extract/exclude.js";
import { openProject } from "../src/extract/ts-adapter.js";
import { generatedConfig } from "./helpers.js";

describe("isGeneratedPath", () => {
  it("excludes a top-level generated directory", () => {
    expect(isGeneratedPath("dist/foo.ts")).toBe(true);
  });

  it("excludes a generated directory nested anywhere in the path", () => {
    expect(isGeneratedPath("packages/a/.next/x.ts")).toBe(true);
    expect(isGeneratedPath("apps/web/.next/types/validator.ts")).toBe(true);
  });

  it("matches whole segments, never substrings", () => {
    // Each of these contains a listed name as a substring and is real source.
    expect(isGeneratedPath("src/distance/foo.ts")).toBe(false);
    expect(isGeneratedPath("src/outbound.ts")).toBe(false);
    expect(isGeneratedPath("src/builders/index.ts")).toBe(false);
    expect(isGeneratedPath("src/outcomes/reducer.ts")).toBe(false);
    expect(isGeneratedPath("src/dist-tags.ts")).toBe(false);
  });

  it("does not treat a file named after a generated directory as generated", () => {
    expect(isGeneratedPath("src/build.ts")).toBe(false);
    expect(isGeneratedPath("out.ts")).toBe(false);
  });

  it("covers every segment the constant lists", () => {
    for (const seg of GENERATED_DIR_SEGMENTS) {
      expect(isGeneratedPath(`${seg}/x.ts`)).toBe(true);
    }
  });
});

describe("openProject generated-directory filtering", () => {
  it("drops generated directories by default and keeps look-alike source", async () => {
    const project = await openProject(generatedConfig());
    expect(project.files().map((f) => f.path)).toEqual([
      "src/distance/measure.ts",
      "src/outbound.ts",
    ]);
  });

  it("keeps generated directories when asked to", async () => {
    const project = await openProject(generatedConfig(), { includeGenerated: true });
    expect(project.files().map((f) => f.path)).toEqual([
      "dist/emitted.ts",
      "packages/a/.next/validator.ts",
      "src/distance/measure.ts",
      "src/outbound.ts",
    ]);
  });
});
