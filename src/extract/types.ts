// Structural types for the parts of the TS API we touch. Keeping our
// own aliases here means an upstream rename is a one-file change.
export interface Node {
  readonly kind: number;
  forEachChild(cb: (child: Node) => unknown): unknown;
  getStart(): number;
  getEnd(): number;
  getText(): string;
}

export interface SourceFileNode extends Node {
  readonly fileName: string;
  readonly text: string;
  readonly imports: readonly Node[];
  getLineAndCharacterOfPosition(pos: number): { line: number; character: number };
}

export interface FileHandle {
  /** Repo-relative, POSIX-separated. */
  path: string;
  /** Absolute, original casing, as returned by getSourceFileNames(). */
  absPath: string;
  contentHash: string;
  sourceFile: SourceFileNode;
}

/** One name a file imports, and where it comes from. */
export interface ImportBinding {
  /** The name this file uses. `B` in `import { A as B }`. */
  local: string;
  /** The name the target exports. `A` in `import { A as B }`; `default` or `*` for those forms. */
  exported: string;
  /** Repo-relative path of the imported file. */
  target: string;
  /** Marked `import type` or `{ type A }`. A type imported without the marker is erased too. */
  typeOnly: boolean;
}

/**
 * What a file imports and declares, by name. The cut search reads this to
 * move single declarations between files.
 */
export interface FileSymbols {
  bindings: readonly ImportBinding[];
  /**
   * Top-level declarations: name -> each [start, end) that declares it. A
   * name can have several spans. A `const` and an `interface` can share a
   * name, and so can the overloads of one function.
   */
  decls: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  /** Names declared by an interface or a type alias. */
  typeNames: ReadonlySet<string>;
  /** True when every top-level declaration is an interface or a type alias. */
  typesOnly: boolean;
  /**
   * Files this file re-exports from with `export … from`, sorted. Unlike
   * `Project.reexportsOf`, this includes a file that also has code of its own.
   */
  reexports: readonly string[];
  /** Every identifier outside import declarations, as [name, position]. */
  uses: readonly (readonly [string, number])[];
}
