import { isBuiltin } from "node:module";
import { SyntaxKind } from "typescript/ast";
import { compareStrings } from "../order.js";
import { forEachChildSafe, safeText, walk } from "./traverse.js";
import type { FileHandle, FileSymbols, ImportBinding, Node, PackageBinding } from "./types.js";

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
  const packageBindings: PackageBinding[] = [];
  const decls = new Map<string, [number, number][]>();
  const typeNames = new Set<string>();
  const uses: [string, number][] = [];
  const reexports = new Set<string>();
  let runtimeDecls = 0;
  let typeDecls = 0;

  forEachChildSafe(file.sourceFile, (stmt) => {
    if (stmt.kind === SyntaxKind.ImportDeclaration) {
      importBindings(stmt, resolve, bindings, packageBindings);
      return;
    }
    if (stmt.kind === SyntaxKind.ExportDeclaration) {
      forEachChildSafe(stmt, (c) => {
        if (c.kind !== SyntaxKind.StringLiteral) return;
        const target = resolve(c);
        if (target !== undefined && target !== file.path) reexports.add(target);
      });
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

  return {
    bindings,
    packageBindings,
    decls,
    typeNames,
    typesOnly: typeDecls > 0 && runtimeDecls === 0,
    reexports: [...reexports].sort(compareStrings),
    uses,
  };
}

function importBindings(
  stmt: Node,
  resolve: (specifier: Node) => string | undefined,
  out: ImportBinding[],
  packages: PackageBinding[],
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
  if (target === undefined) {
    const pkg = packageName(safeText(specifier).slice(1, -1));
    if (pkg !== undefined) for (const local of boundNames(clause)) packages.push({ local, pkg });
    return;
  }
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

/**
 * The npm package a bare specifier names, or undefined for a relative path,
 * an absolute path or a Node built-in.
 */
function packageName(specifier: string): string | undefined {
  if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  if (isBuiltin(specifier)) return undefined;
  const parts = specifier.split("/");
  return parts[0]!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The local names an import clause binds. */
function boundNames(clause: Node): string[] {
  const out: string[] = [];
  forEachChildSafe(clause, (c) => {
    if (c.kind === SyntaxKind.Identifier) out.push(safeText(c));
    else if (c.kind === SyntaxKind.NamespaceImport) {
      const local = firstIdentifier(c);
      if (local !== undefined) out.push(local);
    } else if (c.kind === SyntaxKind.NamedImports) {
      forEachChildSafe(c, (spec) => {
        if (spec.kind !== SyntaxKind.ImportSpecifier) return;
        const ids: string[] = [];
        forEachChildSafe(spec, (x) => {
          if (x.kind === SyntaxKind.Identifier) ids.push(safeText(x));
        });
        if (ids.length > 0) out.push(ids[ids.length - 1]!);
      });
    }
  });
  return out;
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
