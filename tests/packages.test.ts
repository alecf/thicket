import { describe, expect, it } from "vitest";
import { buildPackages, type PackageManifest } from "../src/graph/packages.js";

/** A repo whose package.json files sit at these directories. "" is the root. */
function manifests(byDir: Record<string, PackageManifest>) {
  return (dir: string) => byDir[dir];
}

describe("buildPackages", () => {
  it("assigns a file to the nearest directory holding a package.json", () => {
    const pkgs = buildPackages(
      ["packages/a/src/x.ts", "packages/a/src/deep/y.ts", "packages/b/z.ts", "tools/t.ts"],
      () => [],
      manifests({ "": { deps: [] }, "packages/a": { name: "@r/a", deps: [] }, "packages/b": { deps: [] } }),
    );
    expect(pkgs.of("packages/a/src/x.ts")).toBe("packages/a");
    expect(pkgs.of("packages/a/src/deep/y.ts")).toBe("packages/a");
    expect(pkgs.of("packages/b/z.ts")).toBe("packages/b");
    // No package.json below the root: the root package owns it.
    expect(pkgs.of("tools/t.ts")).toBe("");
  });

  it("treats a repository with no package.json as one package", () => {
    const pkgs = buildPackages(["a/x.ts", "b/y.ts"], () => [], manifests({}));
    expect(pkgs.of("a/x.ts")).toBe("");
    expect(pkgs.canImport(pkgs.of("a/x.ts"), pkgs.of("b/y.ts"))).toBe(true);
  });

  it("lets a package import one it lists as a dependency, by name", () => {
    const pkgs = buildPackages(
      ["packages/app/main.ts", "packages/lib/index.ts"],
      () => [],
      manifests({
        "packages/app": { name: "@r/app", deps: ["@r/lib"] },
        "packages/lib": { name: "@r/lib", deps: [] },
      }),
    );
    expect(pkgs.canImport("packages/app", "packages/lib")).toBe(true);
    // Listing is one-way.
    expect(pkgs.canImport("packages/lib", "packages/app")).toBe(false);
  });

  it("lets a package import one its files already import, listed or not", () => {
    // Path aliases and workspace hoisting make imports that no package.json
    // records. An import that already resolves is the stronger evidence.
    const pkgs = buildPackages(
      ["packages/app/main.ts", "packages/lib/index.ts"],
      (p) => (p === "packages/app/main.ts" ? ["packages/lib/index.ts"] : []),
      manifests({ "packages/app": { deps: [] }, "packages/lib": { name: "@r/lib", deps: [] } }),
    );
    expect(pkgs.canImport("packages/app", "packages/lib")).toBe(true);
    expect(pkgs.canImport("packages/lib", "packages/app")).toBe(false);
  });

  it("refuses an import between sibling packages that do not depend on each other", () => {
    const pkgs = buildPackages(
      ["extensions/css/a.ts", "extensions/html/b.ts"],
      () => [],
      manifests({ "extensions/css": { name: "css", deps: [] }, "extensions/html": { name: "html", deps: [] } }),
    );
    expect(pkgs.canImport("extensions/css", "extensions/html")).toBe(false);
    expect(pkgs.canImport("extensions/css", "extensions/css")).toBe(true);
  });
});
