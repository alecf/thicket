import { SyntaxKind } from "typescript/ast";
import { forEachChildSafe, safeText, walk } from "./traverse.js";
import type { FileHandle, FileSymbols, ImportBinding, Node } from "./types.js";

/**
 * Bindings, declarations and identifier uses of one file.
 *
 * `resolve` maps an import's module specifier node to a repo-relative path.
 * It must be the adapter's synchronous `resolveImport`, which already holds
 * every specifier of the file.
 */
export function fileSymbols(
  file: FileHandle,
  resolve: (specifier: Node) => string | undefined,
): FileSymbols {
  const bindings: ImportBinding[] = [];
  const decls = new Map<string, [number, number][]>();
  const typeNames = new Set<string>();
  const uses: [string, number][] = [];
  let runtimeDecls = 0;
  let typeDecls = 0;

  forEachChildSafe(file.sourceFile, (stmt) => {
    if (stmt.kind === SyntaxKind.ImportDeclaration) {
      importBindings(stmt, resolve, bindings);
      return;
    }
    const names = declaredNames(stmt);
    for (const name of names) {
      const spans = decls.get(name) ?? [];
      spans.push([stmt.getStart(), stmt.getEnd()]);
      decls.set(name, spans);
    }
    if (stmt.kind === SyntaxKind.InterfaceDeclaration || stmt.kind === SyntaxKind.TypeAliasDeclaration) {
      typeDecls++;
      for (const name of names) typeNames.add(name);
    } else if (stmt.kind !== SyntaxKind.ExportDeclaration && stmt.kind !== SyntaxKind.EndOfFile) {
      runtimeDecls++;
    }
    walk(stmt, (n) => {
      if (n.kind === SyntaxKind.Identifier) uses.push([safeText(n), n.getStart()]);
    });
  });

  return { bindings, decls, typeNames, typesOnly: typeDecls > 0 && runtimeDecls === 0, uses };
}

function importBindings(
  stmt: Node,
  resolve: (specifier: Node) => string | undefined,
  out: ImportBinding[],
): void {
  let specifier: Node | undefined;
  let clause: Node | undefined;
  forEachChildSafe(stmt, (c) => {
    if (c.kind === SyntaxKind.StringLiteral) specifier = c;
    if (c.kind === SyntaxKind.ImportClause) clause = c;
  });
  // A side-effect import binds nothing. The module graph still counts it.
  if (specifier === undefined || clause === undefined) return;
  const target = resolve(specifier);
  if (target === undefined) return;
  const clauseType = isTypeOnly(stmt) || isTypeOnly(clause);
  forEachChildSafe(clause, (c) => {
    if (c.kind === SyntaxKind.Identifier) {
      out.push({ local: safeText(c), exported: "default", target, typeOnly: clauseType });
    } else if (c.kind === SyntaxKind.NamespaceImport) {
      const local = firstIdentifier(c);
      if (local !== undefined) out.push({ local, exported: "*", target, typeOnly: clauseType });
    } else if (c.kind === SyntaxKind.NamedImports) {
      forEachChildSafe(c, (spec) => {
        if (spec.kind !== SyntaxKind.ImportSpecifier) return;
        const ids: string[] = [];
        forEachChildSafe(spec, (x) => {
          if (x.kind === SyntaxKind.Identifier) ids.push(safeText(x));
        });
        if (ids.length === 0) return;
        // `{ A as B }` holds A then B. The first is the exported name.
        out.push({
          local: ids[ids.length - 1]!,
          exported: ids[0]!,
          target,
          typeOnly: clauseType || isTypeOnly(spec),
        });
      });
    }
  });
}

/** Names a top-level statement declares. Empty for anything else. */
function declaredNames(stmt: Node): string[] {
  switch (stmt.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration: {
      const name = firstIdentifier(stmt);
      return name === undefined ? [] : [name];
    }
    case SyntaxKind.VariableStatement: {
      // The statement's own declarators only. A walk would also find the
      // locals inside a function body, and each one would then look like a
      // top-level helper.
      const names: string[] = [];
      forEachChildSafe(stmt, (list) => {
        if (list.kind !== SyntaxKind.VariableDeclarationList) return;
        forEachChildSafe(list, (d) => {
          if (d.kind !== SyntaxKind.VariableDeclaration) return;
          const name = firstIdentifier(d);
          if (name !== undefined) names.push(name);
        });
      });
      return names;
    }
    default:
      return [];
  }
}

function firstIdentifier(n: Node): string | undefined {
  let found: string | undefined;
  forEachChildSafe(n, (c) => {
    if (found === undefined && c.kind === SyntaxKind.Identifier) found = safeText(c);
  });
  return found;
}

function isTypeOnly(node: Node): boolean {
  return (node as { isTypeOnly?: boolean }).isTypeOnly === true;
}
