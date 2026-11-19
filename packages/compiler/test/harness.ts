import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Diagnostic, RunResult } from "../src/diagnostics.ts";

export type Kind = "accept" | "reject" | "run";
export const KINDS: Kind[] = ["accept", "reject", "run"];

export interface Compiler {
  check(entryFile: string): Diagnostic[];
  run(entryFile: string): Promise<RunResult>;
  /** Which backend `run` uses; undefined is the JS backend. A `// backend: c` case means
   * different things to the two backends (§14.7), so runCase has to know. */
  backend?: "js" | "c";
}

export interface CaseSpec {
  name: string;
  kind: Kind;
  entry: string; // path of the .ts file carrying the header
  stage: number;
  /** §14.7: the case is C-only; it runs on the C backend alone and needs its C libraries. */
  backend?: "c";
  openQuestion?: string;
  at?: { code: string; line: number; col: number }; // reject: expected code/position; run: unused
  output?: string[]; // run: expected stdout lines (undefined when no run expectation on output)
  trap?: { code: string; line: number; col: number };
  /** accept: the exact warnings `check` must report (Q187), in position order. */
  warnings?: { code: string; line: number; col: number }[];
}

const POS = /^([ET]\d{3,4}) @ (\d+):(\d+)$/;

/** Parse the header of one case's entry file. Throws on malformed headers. */
export function parseCase(entry: string, name = entry): CaseSpec {
  const lines = readFileSync(entry, "utf8").split("\n");
  const bad = (n: number, msg: string): never => {
    throw new Error(`${entry}:${n + 1}: ${msg}`);
  };
  let i = 0;
  const first = lines[0] ?? "";
  const spec: Partial<CaseSpec> = { name, entry };

  if (first.startsWith("// expect:")) {
    const v = first.slice("// expect:".length).trim();
    if (v === "ok") {
      spec.kind = "accept";
      spec.warnings = [];
      while ((lines[1 + spec.warnings.length] ?? "").startsWith("// expect-warning:")) {
        const m = /^(W\d{4}) @ (\d+):(\d+)$/.exec((lines[1 + spec.warnings.length] as string).slice("// expect-warning:".length).trim());
        if (!m) return bad(1 + spec.warnings.length, "bad '// expect-warning:' value (want 'W8001 @ 8:14')");
        spec.warnings.push({ code: m[1]!, line: +m[2]!, col: +m[3]! });
      }
    }
    else {
      const m = POS.exec(v);
      if (!m || !m[1]!.startsWith("E")) return bad(0, `bad '// expect:' value '${v}' (want 'ok' or 'E3001 @ 12:9')`);
      spec.kind = "reject";
      spec.at = { code: m[1]!, line: +m[2]!, col: +m[3]! };
    }
    i = 1 + (spec.warnings?.length ?? 0);
  } else if (first.startsWith("// expect-output:") || first === "// expect-no-output" || first.startsWith("// expect-trap:")) {
    spec.kind = "run";
    if (first === "// expect-no-output") { spec.output = []; i = 1; }
    else {
      const out: string[] = [];
      while ((lines[i] ?? "").startsWith("// expect-output:")) {
        out.push((lines[i] as string).slice("// expect-output:".length).replace(/^ /, ""));
        i++;
      }
      if (out.length) spec.output = out;
    }
    if ((lines[i] ?? "").startsWith("// expect-trap:")) {
      const m = POS.exec((lines[i] as string).slice("// expect-trap:".length).trim());
      if (!m || !m[1]!.startsWith("T")) return bad(i, "bad '// expect-trap:' value (want 'T001 @ 8:14')");
      spec.trap = { code: m[1]!, line: +m[2]!, col: +m[3]! };
      i++;
    }
    if (!spec.output && !spec.trap) return bad(0, "run case needs expectations");
  } else {
    return bad(0, "line 1 must be '// expect: ...', '// expect-output: ...', '// expect-no-output' or '// expect-trap: ...'");
  }

  const st = /^\/\/ stage: (\d+)$/.exec(lines[i] ?? "");
  if (!st) return bad(i, "missing '// stage: N' directly after the expectation header");
  spec.stage = +st[1]!;
  i++;
  if ((lines[i] ?? "") === "// backend: c") { spec.backend = "c"; i++; }
  else if ((lines[i] ?? "").startsWith("// backend:")) return bad(i, "bad '// backend:' line (want '// backend: c')");
  while ((lines[i] ?? "").startsWith("// open-question:")) {
    const q = /^\/\/ open-question: (Q\d+)$/.exec(lines[i] as string);
    if (!q) return bad(i, "bad '// open-question:' line (want 'Q012')");
    spec.openQuestion = q[1]!;
    i++;
  }
  return spec as CaseSpec;
}

/** Load all cases under root/{accept,reject,run}. A case is `x.ts` or a directory `x/` with `main.ts`. */
export function loadCases(root: string): CaseSpec[] {
  const cases: CaseSpec[] = [];
  for (const kind of KINDS) {
    const dir = join(root, kind);
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(dir, n);
      let spec: CaseSpec;
      if (statSync(p).isDirectory()) spec = parseCase(join(p, "main.ts"), `${kind}/${n}`);
      else if (n.endsWith(".ts")) spec = parseCase(p, `${kind}/${n}`);
      else continue;
      if (spec.kind !== kind) throw new Error(`${spec.entry}: header is a '${spec.kind}' case but the file is under ${kind}/`);
      cases.push(spec);
    }
  }
  return cases;
}

/** Keep cases with stage <= maxStage; undefined keeps all. */
export function filterByStage(cases: CaseSpec[], maxStage?: number): CaseSpec[] {
  return maxStage === undefined ? cases : cases.filter((c) => c.stage <= maxStage);
}

/** Run one case; returns failure messages (empty = pass). Never throws. */
export async function runCase(spec: CaseSpec, compiler: Compiler): Promise<string[]> {
  try {
    if (spec.kind === "accept") {
      const ds = compiler.check(spec.entry);
      const fails = ds.filter((d) => d.severity === "error").map((d) => `unexpected ${d.code} @ ${d.range.start.line}:${d.range.start.col}`);
      const got = ds.filter((d) => d.severity === "warning").map((d) => `${d.code} @ ${d.range.start.line}:${d.range.start.col}`).sort();
      const want = (spec.warnings ?? []).map((w) => `${w.code} @ ${w.line}:${w.col}`).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`warnings: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      return fails;
    }
    if (spec.kind === "reject") {
      // §14.7: E4009 is reported by `run` / `test` before executing, never by `check`,
      // so an E4009 case is verified through run's diagnostics.
      const all = spec.at!.code === "E4009" ? (await compiler.run(spec.entry)).diagnostics : compiler.check(spec.entry);
      const d = [...all].sort(
        (a, b) => a.range.start.line - b.range.start.line || a.range.start.col - b.range.start.col || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
      )[0];
      const want = spec.at!;
      if (!d) return [`expected ${want.code} @ ${want.line}:${want.col}, got no diagnostics`];
      const s = d.range.start;
      if (d.code === want.code && s.line === want.line && s.col === want.col) return [];
      return [`expected ${want.code} @ ${want.line}:${want.col}, got ${d.code} @ ${s.line}:${s.col}`];
    }
    if (spec.backend === "c" && (compiler.backend ?? "js") === "js") {
      // §14.7: on the JS backend a C-only case executes nothing and stops with E4009.
      const r = await compiler.run(spec.entry);
      const fails: string[] = [];
      if (r.diagnostics.length !== 1 || r.diagnostics[0]!.code !== "E4009") {
        fails.push(`expected the JS backend to stop with E4009, got ${r.diagnostics.length ? r.diagnostics.map((d) => d.code).join(", ") : "no diagnostics"}`);
      }
      if (r.stdout !== "") fails.push(`expected no stdout, got ${JSON.stringify(r.stdout)}`);
      if (r.trap) fails.push(`unexpected trap ${r.trap.code} @ ${r.trap.line}:${r.trap.col}`);
      return fails;
    }
    const r = await compiler.run(spec.entry);
    const fails: string[] = r.diagnostics.map((d) => `unexpected diagnostic ${d.code}`);
    if (spec.output) {
      const got = r.stdout === "" ? [] : r.stdout.replace(/\n$/, "").split("\n");
      if (JSON.stringify(got) !== JSON.stringify(spec.output)) {
        fails.push(`stdout mismatch: expected ${JSON.stringify(spec.output)}, got ${JSON.stringify(got)}`);
      }
    }
    if (spec.trap) {
      const w = spec.trap, t = r.trap;
      if (!t) fails.push(`expected trap ${w.code} @ ${w.line}:${w.col}, got none`);
      else if (t.code !== w.code || t.line !== w.line || t.col !== w.col) {
        fails.push(`expected trap ${w.code} @ ${w.line}:${w.col}, got ${t.code} @ ${t.line}:${t.col}`);
      }
    } else if (r.trap) fails.push(`unexpected trap ${r.trap.code} @ ${r.trap.line}:${r.trap.col}`);
    return fails;
  } catch (e) {
    return [`threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`];
  }
}

/** The files that make up a case: its entry file, plus the other sources of a directory case. */
export function caseFiles(spec: CaseSpec): string[] {
  if (basename(spec.entry) !== "main.ts") return [spec.entry];
  const dir = dirname(spec.entry);
  return readdirSync(dir).filter((n) => n.endsWith(".ts")).sort().map((n) => join(dir, n));
}

/** The pkg-config packages named by the `c:` specifiers (§14.1) a case's sources declare or
 * import, in first-use order. */
export function cPackages(spec: CaseSpec): string[] {
  const out: string[] = [];
  for (const f of caseFiles(spec)) {
    for (const m of readFileSync(f, "utf8").matchAll(/"c:([^":<>\s\\]+):/g)) {
      if (!out.includes(m[1]!)) out.push(m[1]!);
    }
  }
  return out;
}

/** The case's C packages that `exists` (a pkg-config lookup) does not know. A `// backend: c`
 * case with any of these is skipped in this environment, never failed (§14.7). */
export function missingCPackages(spec: CaseSpec, exists: (pkg: string) => boolean): string[] {
  return cPackages(spec).filter((p) => !exists(p));
}

/** Whether a reject case's expected position is the `c:` specifier literal itself. A package or
 * header failure anchors there in every environment (§14.2), so such a case runs even where the
 * package is unavailable; a function-name failure only exists where the library does. */
export function atCSpecifier(spec: CaseSpec): boolean {
  if (!spec.at) return false;
  const line = readFileSync(spec.entry, "utf8").split("\n")[spec.at.line - 1] ?? "";
  return line.startsWith('"c:', spec.at.col - 1);
}
