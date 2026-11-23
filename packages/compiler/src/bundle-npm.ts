// Shared static npm: dependency bundler for browser and standalone Node targets (zero external deps, CSP-safe).
// shortcut: regex-based static ESM/CJS bundler for npm: dependencies (handles static import/export/require, JSON, .ts); upgrade to a full JS parser/bundler (e.g. esbuild/rolldown) if packages with dynamic require() expressions or complex UMD wrappers are needed.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "./index.ts";

export interface NpmBundleResult {
  /** Map from `"npm:<spec>"` to relative output path from `outDir`, e.g. `"./vendor/v0.js"`. */
  readonly entries: Map<string, string>;
  /** Relative file paths written inside `outDir`, e.g. `"vendor/v0.js"`. */
  readonly files: string[];
}

/** Formats static ESM imports and the unwrapped `BUNDLED_NPM` lookup map for generated entrypoints. */
export function emitNpmPreamble(entries: ReadonlyMap<string, string>): { header: string[]; mapDecl: string } {
  const list = [...entries.entries()];
  const header = list.map(([, rel], i) => `import * as __npm${i} from ${JSON.stringify(rel)};`);
  const unwrap = list.length ? `const __unwrap = (m) => (m && m.__szCjs ? m.default : m);\n` : "";
  const pairs = list.map(([spec], i) => `${JSON.stringify(spec)}: __unwrap(__npm${i})`).join(", ");
  return { header, mapDecl: `${unwrap}const BUNDLED_NPM = { ${pairs} };` };
}

type ModKind = "esm" | "cjs" | "json";
type Resolved =
  | { kind: "builtin"; spec: string }
  | { kind: "file"; path: string; modKind: ModKind };

interface PackageJson {
  type?: string;
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
}

const BUILTIN_SET = new Set(builtinModules.map((m) => (m.startsWith("node:") ? m.slice(5) : m)));
const isBuiltin = (s: string): boolean => s.startsWith("node:") || BUILTIN_SET.has(s);
const normBuiltin = (s: string): string => (s.startsWith("node:") ? s : `node:${s}`);
const isFile = (p: string): boolean => {
  try { return statSync(p).isFile(); } catch { return false; }
};

function readJson(p: string): PackageJson | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as PackageJson; } catch { return null; }
}

function nearestPkgType(filePath: string): string | undefined {
  let dir = dirname(filePath);
  for (;;) {
    const pj = join(dir, "package.json");
    if (isFile(pj)) return readJson(pj)?.type;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function classifyFile(absPath: string, rawSrc: string): { kind: ModKind; src: string } {
  const ext = extname(absPath);
  if (ext === ".json") return { kind: "json", src: rawSrc };
  if (ext === ".mjs") return { kind: "esm", src: rawSrc };
  if (ext === ".cjs") return { kind: "cjs", src: rawSrc };
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
    const stripped = stripTypeScriptTypes(rawSrc);
    return { kind: ext === ".cts" ? "cjs" : "esm", src: stripped };
  }
  if (nearestPkgType(absPath) === "module") return { kind: "esm", src: rawSrc };
  // Fall back to syntax detection for extensionless/"commonjs" packages that ship ESM with `.js`.
  const hasEsmSyntax = /(?:^|[;\n])\s*(?:import\s+(?:[\s\S]*?\s+from\s+|["'])|export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|\{|\*))/.test(rawSrc);
  return { kind: hasEsmSyntax ? "esm" : "cjs", src: rawSrc };
}

function tryFileCandidates(base: string): string | undefined {
  if (isFile(base)) return realpathSync(base);
  for (const ext of [".mjs", ".js", ".cjs", ".json", ".mts", ".ts"]) {
    if (isFile(base + ext)) return realpathSync(base + ext);
  }
  for (const idx of ["index.mjs", "index.js", "index.cjs", "index.json"]) {
    const p = join(base, idx);
    if (isFile(p)) return realpathSync(p);
  }
  return undefined;
}

function pickCondition(node: unknown, conditions: readonly string[]): string | undefined {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = pickCondition(item, conditions);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const cond of conditions) {
      if (Object.hasOwn(obj, cond)) {
        const hit = pickCondition(obj[cond], conditions);
        if (hit) return hit;
      }
    }
    // In case keys are unmatched before "default", scan any matched condition already handled above.
    if (Object.hasOwn(obj, "default")) return pickCondition(obj.default, conditions);
  }
  return undefined;
}

function resolveExports(exportsField: unknown, sub: string, conditions: readonly string[]): string | undefined {
  if (!exportsField) return undefined;
  if (typeof exportsField === "string") return sub === "." ? exportsField : undefined;
  if (typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const obj = exportsField as Record<string, unknown>;
    const keys = Object.keys(obj);
    const hasSubpathKeys = keys.some((k) => k.startsWith("."));
    if (hasSubpathKeys) {
      if (Object.hasOwn(obj, sub)) return pickCondition(obj[sub], conditions);
      for (const pat of keys) {
        const star = pat.indexOf("*");
        if (star < 0) continue;
        const pre = pat.slice(0, star), suf = pat.slice(star + 1);
        if (sub.startsWith(pre) && sub.endsWith(suf) && sub.length >= pre.length + suf.length) {
          const wild = sub.slice(pre.length, sub.length - suf.length);
          const hit = pickCondition(obj[pat], conditions);
          if (hit) return hit.replaceAll("*", wild);
        }
      }
      return undefined;
    }
    if (sub === ".") return pickCondition(obj, conditions);
  }
  return undefined;
}

const NPM_PKG_SEG = /^[A-Za-z0-9._-]+$/;

/** Validates top-level `npm:<spec>` names (builtins or package/subpath without `.`, `..`, leading `/`, or backslashes). */
export function isValidNpmSpecifier(spec: string): boolean {
  if (!spec) return false;
  if (isBuiltin(spec)) return true;
  if (spec.startsWith(".") || spec.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(spec)) return false;
  const parts = spec.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return false;
  if (spec.startsWith("@")) return parts.length >= 2 && /^@[A-Za-z0-9._-]+$/.test(parts[0]!) && NPM_PKG_SEG.test(parts[1]!);
  return NPM_PKG_SEG.test(parts[0]!);
}

const isWithinDir = (realRoot: string, candidate: string): boolean =>
  candidate === realRoot || candidate.startsWith(realRoot + sep);

function splitPkgSpec(spec: string): { pkgName: string; sub: string } {
  const parts = spec.split("/");
  const pkgName = spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
  const restIdx = spec.startsWith("@") ? 2 : 1;
  const sub = parts.length > restIdx ? `./${parts.slice(restIdx).join("/")}` : ".";
  return { pkgName, sub };
}

function findPackageFile(fromFile: string, spec: string, allowNodeBuiltins: boolean, allowRelative = true): string | undefined {
  const conditions = allowNodeBuiltins
    ? ["node", "import", "default", "require"]
    : ["browser", "import", "module", "default", "require"];
  if (spec.startsWith("/")) return undefined;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    if (!allowRelative) return undefined;
    return tryFileCandidates(resolve(dirname(fromFile), spec));
  }
  if (!isValidNpmSpecifier(spec)) return undefined;
  const { pkgName, sub } = splitPkgSpec(spec);
  let dir = dirname(fromFile);
  for (;;) {
    const pkgDir = join(dir, "node_modules", pkgName);
    if (existsSync(pkgDir)) {
      let realPkgDir = "";
      try { realPkgDir = realpathSync(pkgDir); } catch { realPkgDir = ""; }
      if (realPkgDir) {
        const tryContained = (base: string): string | undefined => {
          const hit = tryFileCandidates(base);
          return hit && isWithinDir(realPkgDir, hit) ? hit : undefined;
        };
        const pj = readJson(join(pkgDir, "package.json"));
        if (pj) {
          const expTarget = resolveExports(pj.exports, sub, conditions);
          if (expTarget) {
            const hit = tryContained(resolve(pkgDir, expTarget));
            if (hit) return hit;
          }
          if (sub === ".") {
            if (!allowNodeBuiltins && typeof pj.browser === "string") {
              const hit = tryContained(resolve(pkgDir, pj.browser));
              if (hit) return hit;
            }
            for (const field of [pj.module, pj.main]) {
              if (typeof field === "string") {
                const hit = tryContained(resolve(pkgDir, field));
                if (hit) return hit;
              }
            }
          }
        }
        const subHit = tryContained(sub === "." ? join(pkgDir, "index.js") : resolve(pkgDir, sub));
        if (subHit) return subHit;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try { return realpathSync(createRequire(fromFile).resolve(spec)); } catch { return undefined; }
}

/**
 * Resolves and bundles all `"npm:<name>"` imports statically into `outDir/vendor/v*.js`.
 * Rejects `node:*` imports with `CliError` when `allowNodeBuiltins` is false (`--target=browser`).
 */
export function bundleNpmImports(
  imports: Iterable<{ fromFile: string; spec: string }>,
  outDir: string,
  opts: { allowNodeBuiltins: boolean },
): NpmBundleResult {
  const entries = new Map<string, string>();
  const written: string[] = [];
  const visited = new Map<string, { id: string; relFromVendor: string; modKind: ModKind }>();
  const emitted = new Set<string>();
  let nextId = 0;

  const resolveDep = (fromFile: string, reqSpec: string, origLabel: string, allowRelative = true): Resolved => {
    if (isBuiltin(reqSpec)) {
      if (!opts.allowNodeBuiltins) {
        throw new CliError(`npm dependency '${origLabel}' imports Node builtin '${reqSpec}', which is not supported for --target=browser`);
      }
      return { kind: "builtin", spec: normBuiltin(reqSpec) };
    }
    if (!allowRelative && !isValidNpmSpecifier(reqSpec)) {
      throw new CliError(`invalid npm specifier '${origLabel}'`);
    }
    const abs = findPackageFile(fromFile, reqSpec, opts.allowNodeBuiltins, allowRelative);
    if (!abs) throw new CliError(`cannot resolve '${reqSpec}' (from '${origLabel}')`);
    const existing = visited.get(abs);
    if (existing) return { kind: "file", path: abs, modKind: existing.modKind };
    const raw = readFileSync(abs, "utf8");
    const { kind } = classifyFile(abs, raw);
    const id = `v${nextId++}`;
    visited.set(abs, { id, relFromVendor: `./${id}.js`, modKind: kind });
    return { kind: "file", path: abs, modKind: kind };
  };

  const emitVendorModule = (absPath: string, origLabel: string): { id: string; relFromVendor: string; modKind: ModKind } => {
    const info = visited.get(absPath)!;
    if (emitted.has(absPath)) return info;
    emitted.add(absPath);

    const raw = readFileSync(absPath, "utf8");
    const classified = classifyFile(absPath, raw);
    const outRel = `vendor/${info.id}.js`;
    const vendorDir = join(outDir, "vendor");
    mkdirSync(vendorDir, { recursive: true });

    let code: string;
    if (classified.kind === "json") {
      code = `export const __szCjs = true;\nexport default ${classified.src.trim()};\n`;
    } else if (classified.kind === "cjs") {
      code = rewriteCjs(absPath, classified.src, origLabel);
    } else {
      code = rewriteEsm(absPath, classified.src, origLabel);
    }

    writeFileSync(join(outDir, outRel), code);
    written.push(outRel);
    return info;
  };

  const ensureDep = (fromFile: string, reqSpec: string, origLabel: string, allowRelative = true): { targetSpec: string; modKind: ModKind | "builtin" } => {
    const r = resolveDep(fromFile, reqSpec, origLabel, allowRelative);
    if (r.kind === "builtin") return { targetSpec: r.spec, modKind: "builtin" };
    const info = emitVendorModule(r.path, origLabel);
    return { targetSpec: info.relFromVendor, modKind: info.modKind };
  };

  const rewriteCjs = (absPath: string, src: string, origLabel: string): string => {
    const depSpecs: string[] = [];
    const depIndex = new Map<string, number>();
    const header: string[] = [];
    const depEntries: string[] = [];

    const body = src.replace(/(?<![.\w$])require\s*\(\s*(["'])([^"']+)\1\s*\)/g, (_m, _q: string, reqSpec: string) => {
      if (!depIndex.has(reqSpec)) {
        const dep = ensureDep(absPath, reqSpec, origLabel);
        const idx = depSpecs.length;
        depSpecs.push(reqSpec);
        depIndex.set(reqSpec, idx);
        const varName = `__dep${idx}`;
        if (dep.modKind === "cjs" || dep.modKind === "json" || dep.modKind === "builtin") {
          header.push(`import ${varName} from ${JSON.stringify(dep.targetSpec)};`);
          depEntries.push(`${JSON.stringify(reqSpec)}: ${varName}`);
        } else {
          header.push(`import * as ${varName} from ${JSON.stringify(dep.targetSpec)};`);
          depEntries.push(`${JSON.stringify(reqSpec)}: (__nsToCjs(${varName}))`);
        }
      }
      return `__req(${JSON.stringify(reqSpec)})`;
    });

    const nsHelper = header.some((h) => h.startsWith("import * as"))
      ? `const __nsToCjs = (m) => { const ks = Object.keys(m); return ks.length === 1 && ks[0] === "default" ? m.default : { ...m, ...(m.default && typeof m.default === "object" ? m.default : {}) }; };\n`
      : "";
    const reqRuntime = depEntries.length
      ? `const __deps = { ${depEntries.join(", ")} };\nconst __req = (s) => { if (Object.hasOwn(__deps, s)) return __deps[s]; throw new Error("dynamic require not supported: " + s); };\n`
      : `const __req = (s) => { throw new Error("dynamic require not supported: " + s); };\n`;

    return [
      ...header,
      nsHelper + reqRuntime + `const __mod = { exports: {} };`,
      `(function (module, exports, require) {`,
      body,
      `})(__mod, __mod.exports, __req);`,
      `export const __szCjs = true;`,
      `export default __mod.exports;`,
      "",
    ].join("\n");
  };

  const rewriteEsm = (absPath: string, src: string, origLabel: string): string => {
    let cjsTmp = 0;
    const convertNamed = (specList: string): string =>
      specList.replace(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\b/g, "$1: $2");

    let out = src;
    // Rewrite static `import ... from "spec"` statements cleanly, handling CJS interop.
    out = out.replace(
      /(^[ \t]*import\s+)([^;"']+?)(\s+from\s+)(["'])([^"']+)\4([ \t]*;?)/gm,
      (full, kw: string, clause: string, fromKw: string, _q: string, reqSpec: string, semi: string) => {
        const dep = ensureDep(absPath, reqSpec, origLabel);
        if (dep.modKind !== "cjs" && dep.modKind !== "json") {
          return `${kw}${clause}${fromKw}${JSON.stringify(dep.targetSpec)}${semi}`;
        }
        const trimmed = clause.trim();
        if (trimmed.startsWith("{")) {
          const tmp = `__cjs${cjsTmp++}`;
          return `import ${tmp} from ${JSON.stringify(dep.targetSpec)};\nconst ${convertNamed(trimmed)} = ${tmp}${semi}`;
        }
        if (trimmed.startsWith("*")) {
          const m = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
          if (m) return `import ${m[1]} from ${JSON.stringify(dep.targetSpec)}${semi}`;
          return full;
        }
        const comma = trimmed.indexOf(",");
        if (comma >= 0) {
          const def = trimmed.slice(0, comma).trim();
          const rest = trimmed.slice(comma + 1).trim();
          if (rest.startsWith("{")) {
            return `import ${def} from ${JSON.stringify(dep.targetSpec)};\nconst ${convertNamed(rest)} = ${def}${semi}`;
          }
          const m = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(rest);
          if (m) return `import ${def} from ${JSON.stringify(dep.targetSpec)};\nconst ${m[1]} = ${def}${semi}`;
        }
        return `${kw}${clause}${fromKw}${JSON.stringify(dep.targetSpec)}${semi}`;
      },
    );

    // Side-effect imports: `import "spec";`
    out = out.replace(
      /(^[ \t]*import\s+)(["'])([^"']+)\2([ \t]*;?)/gm,
      (_m, kw: string, _q: string, reqSpec: string, semi: string) => {
        const dep = ensureDep(absPath, reqSpec, origLabel);
        return `${kw}${JSON.stringify(dep.targetSpec)}${semi}`;
      },
    );

    // Re-exports: `export { ... } from "spec";`, `export * from "spec";`, and `export * as ns from "spec";`
    out = out.replace(
      /(^[ \t]*export\s+)(\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})(\s+from\s+)(["'])([^"']+)\4([ \t]*;?)/gm,
      (full, kw: string, clause: string, fromKw: string, _q: string, reqSpec: string, semi: string) => {
        const dep = ensureDep(absPath, reqSpec, origLabel);
        if (dep.modKind !== "cjs" && dep.modKind !== "json") {
          return `${kw}${clause}${fromKw}${JSON.stringify(dep.targetSpec)}${semi}`;
        }
        const trimmed = clause.trim();
        if (trimmed.startsWith("*")) {
          const nsMatch = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
          if (nsMatch) {
            const tmp = `__cjs${cjsTmp++}`;
            return `import ${tmp} from ${JSON.stringify(dep.targetSpec)};\nexport const ${nsMatch[1]} = ${tmp}${semi}`;
          }
          throw new CliError(`npm bundler: 'export * from ${JSON.stringify(reqSpec)}' from ${dep.modKind} module is not supported (in ${origLabel})`);
        }
        if (trimmed.startsWith("{")) {
          const tmp = `__cjs${cjsTmp++}`;
          const items = trimmed.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
          const decls: string[] = [];
          const reDefs: string[] = [];
          for (const it of items) {
            if (it === "default") { reDefs.push(`${tmp} as default`); continue; }
            const m = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(it);
            if (m) decls.push(m[1] === "default" ? `${m[2]} = ${tmp}` : `${m[2]} = ${tmp}.${m[1]}`);
            else decls.push(`${it} = ${tmp}.${it}`);
          }
          const lines = [`import ${tmp} from ${JSON.stringify(dep.targetSpec)};`];
          if (decls.length) lines.push(`export const ${decls.join(", ")}${semi}`);
          if (reDefs.length) lines.push(`export { ${reDefs.join(", ")} }${semi}`);
          return lines.join("\n");
        }
        return full;
      },
    );

    // Static dynamic imports: `import("spec")`
    out = out.replace(/(?<![.\w$])import\s*\(\s*(["'])([^"']+)\1\s*\)/g, (_m, _q: string, reqSpec: string) => {
      const dep = ensureDep(absPath, reqSpec, origLabel);
      if (dep.modKind === "cjs" || dep.modKind === "json") {
        return `import(${JSON.stringify(dep.targetSpec)}).then((m) => m.default)`;
      }
      return `import(${JSON.stringify(dep.targetSpec)})`;
    });

    return out;
  };

  for (const { fromFile, spec } of imports) {
    if (!spec.startsWith("npm:") || entries.has(spec)) continue;
    const pkgSpec = spec.slice(4);
    const dep = ensureDep(fromFile, pkgSpec, spec, false);
    if (dep.modKind === "builtin") {
      entries.set(spec, dep.targetSpec);
    } else {
      entries.set(spec, `./vendor/${dep.targetSpec.slice(2)}`);
    }
  }

  return { entries, files: written };
}

/** Unwraps bundled CJS markers or Node opaque CJS (`default`-only) namespaces to their exports object. */
export function unwrapImportedNpm(mod: unknown): unknown {
  if (!mod || typeof mod !== "object") return mod;
  const rec = mod as Record<string, unknown>;
  if (rec.__szCjs) return rec.default;
  const def = rec.default;
  if (def !== null && (typeof def === "object" || typeof def === "function")) {
    const keys = Object.keys(rec);
    if (keys.every((k) => k === "default" || k === "module.exports")) return def;
  }
  return mod;
}

/** Loads an `"npm:<name>"` dependency for direct Node execution, preferring ESM entries and unwrapping opaque CJS. */
export async function loadNpmModule(fromFile: string, spec: string): Promise<{ mod: unknown; url: string }> {
  const name = spec.slice(4);
  if (!isValidNpmSpecifier(name)) throw new CliError(`invalid npm specifier '${spec}'`);
  let url = name;
  const esmHit = !isBuiltin(name) ? findPackageFile(fromFile, name, true, false) : undefined;
  if (esmHit) {
    url = pathToFileURL(esmHit).href;
  } else {
    try { url = pathToFileURL(createRequire(fromFile).resolve(name)).href; } catch { /* shortcut: fall back to Node's own resolution from the compiler */ }
  }
  try {
    return { mod: unwrapImportedNpm(await import(url)), url };
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") throw new CliError(`cannot resolve '${spec}'`); // Q252
    throw e;
  }
}
