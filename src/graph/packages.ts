/**
 * Which package a file belongs to, and which packages can import which.
 *
 * A package is the nearest directory at or above a file that holds a
 * `package.json`. A repository with none is one package, the root.
 *
 * Placement needs this because a package is a boundary the import graph does
 * not show. Judged on four public repositories, a home in a package that
 * another copy's package cannot import was rated wrong 63 times in 72
 * (docs/plans/2026-11-11-placement.md). Separately bundled VS Code extensions
 * are the plain case: two extensions repeat a helper, and neither can import
 * the other.
 */

/** What placement reads from one `package.json`. */
export interface PackageManifest {
  name?: string;
  /** Names from `dependencies`, `devDependencies` and `peerDependencies`. */
  deps: readonly string[];
}

export interface Packages {
  /** The repo-relative directory of the package that owns `path`; "" is the root. */
  of(path: string): string;
  /**
   * Whether code in package `from` can import package `to`. True for the same
   * package, for a dependency listed by name, and for any package that files
   * of `from` already import. The last covers path aliases and hoisted
   * workspaces, where an import resolves with no `package.json` entry.
   */
  canImport(from: string, to: string): boolean;
  /**
   * Whether code in package `pkg` can import the npm package `name`. True
   * when its package.json lists it, or when one of its files already imports
   * it. The second covers hoisted workspaces and path aliases.
   */
  canUse(pkg: string, name: string): boolean;
}

const parentOf = (dir: string) => {
  const slash = dir.lastIndexOf("/");
  return slash === -1 ? "" : dir.slice(0, slash);
};

/**
 * `read(dir)` returns the manifest at `dir`, or undefined when the directory
 * holds no `package.json`. `dir` is repo-relative and "" is the root.
 */
export function buildPackages(
  files: readonly string[],
  importsOf: (path: string) => readonly string[],
  read: (dir: string) => PackageManifest | undefined,
  /** The npm packages a file imports by name. */
  packageImportsOf: (path: string) => readonly string[] = () => [],
): Packages {
  const manifests = new Map<string, PackageManifest | undefined>();
  const manifest = (dir: string) => {
    if (!manifests.has(dir)) manifests.set(dir, read(dir));
    return manifests.get(dir);
  };

  const owner = new Map<string, string>();
  const ownerOfDir = (start: string): string => {
    const walked: string[] = [];
    let dir = start;
    let found: string;
    for (;;) {
      const cached = owner.get(dir);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      walked.push(dir);
      if (manifest(dir) !== undefined || dir === "") {
        found = dir;
        break;
      }
      dir = parentOf(dir);
    }
    for (const d of walked) owner.set(d, found);
    return found;
  };
  const of = (path: string) => ownerOfDir(parentOf(path));

  // Package pairs that an existing import already crosses.
  const crossed = new Set<string>();
  for (const file of files) {
    const from = of(file);
    for (const target of importsOf(file)) {
      const to = of(target);
      if (from !== to) crossed.add(`${from}\u0000${to}`);
    }
  }

  // npm packages each package's files import, built per package on first use.
  const used = new Map<string, Set<string>>();
  const usedBy = (pkg: string) => {
    let names = used.get(pkg);
    if (names === undefined) {
      names = new Set(files.filter((f) => of(f) === pkg).flatMap((f) => packageImportsOf(f)));
      used.set(pkg, names);
    }
    return names;
  };

  return {
    of,
    canImport(from, to) {
      if (from === to || crossed.has(`${from}\u0000${to}`)) return true;
      const name = manifest(to)?.name;
      return name !== undefined && (manifest(from)?.deps.includes(name) ?? false);
    },
    canUse(pkg, name) {
      return (manifest(pkg)?.deps.includes(name) ?? false) || usedBy(pkg).has(name);
    },
  };
}
