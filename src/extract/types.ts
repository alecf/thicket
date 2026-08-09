// Structural types for the parts of the unstable TS API we touch. Keeping our
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
