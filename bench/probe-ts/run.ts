// Not part of CI. Converts bench/probe-ts/ts/*.ts with the eval-20261124 boilerplate transform
// and measures initial compilation acceptance and exact Node output match rate.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function convertBoilerplate(src: string): string {
  const splitArgs = (s: string): string[] => {
    const out: string[] = [];
    let d = 0, cur = "", q: string | null = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (q) {
        cur += c;
        if (c === "\\") cur += s[++i] ?? "";
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
      if ("([{".includes(c)) d++;
      if (")]}".includes(c)) d--;
      if (c === "," && d === 0) { out.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  let out = "", i = 0;
  const key = "console.log(";
  while (true) {
    const j = src.indexOf(key, i);
    if (j < 0) { out += src.slice(i); break; }
    out += src.slice(i, j);
    let k = j + key.length, d = 1, q: string | null = null;
    for (; k < src.length && d > 0; k++) {
      const c = src[k]!;
      if (q) { if (c === "\\") k++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(") d++;
      if (c === ")") d--;
    }
    const args = splitArgs(src.slice(j + key.length, k - 1));
    const body = args.length === 1 && /^["`]/.test(args[0]!)
      ? args[0]!
      : "`" + args.map((a) => (/^"[^"\\]*"$/.test(a) ? a.slice(1, -1) : "${" + a + "}")).join(" ") + "`";
    out += `sys.log.info(${body})`;
    i = k;
  }
  return out
    .replace(/^function main\(\): void \{/m, "export function main(sys: System): void {")
    .replace(/^async function main\(\): Promise<void> \{/m, "export async function main(sys: System): Promise<void> {")
    .replace(/^main\(\);\n/m, "");
}

function parseCompilerArg(argv: string[]): string {
  const idx = argv.indexOf("--compiler");
  if (idx >= 0) {
    const p = argv[idx + 1];
    if (!p) throw new Error("--compiler requires a path");
    return resolve(p);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../packages/compiler/src/cli.ts");
}

const here = dirname(fileURLToPath(import.meta.url));
const compilerCli = parseCompilerArg(process.argv.slice(2));
const tsDir = join(here, "ts");
const outDir = join(here, "out");
const files = readdirSync(tsDir).filter((f) => f.endsWith(".ts")).sort();

const tmpDir = mkdtempSync(join(tmpdir(), "szigyr-probe-ts-"));
let accepted = 0;
let matched = 0;

try {
  for (const file of files) {
    const stem = file.slice(0, -3);
    const dst = join(tmpDir, `${stem}.szigyr`);
    writeFileSync(dst, convertBoilerplate(readFileSync(join(tsDir, file), "utf8")));
    const chk = spawnSync(process.execPath, [compilerCli, "check", dst], { encoding: "utf8" });
    if (chk.status !== 0) {
      const msg = (chk.stderr || chk.stdout).trim().split("\n")[0] ?? `exit ${chk.status}`;
      console.log(`REJECT   ${stem}: ${msg}`);
      continue;
    }
    accepted++;
    const runRes = spawnSync(process.execPath, [compilerCli, "run", dst], { encoding: "utf8" });
    const expected = readFileSync(join(outDir, `${stem}.node.txt`), "utf8");
    if (runRes.status === 0 && runRes.stdout === expected) {
      matched++;
      console.log(`PASS     ${stem}`);
    } else {
      const actual = runRes.status === 0 ? runRes.stdout : `[exit ${runRes.status}] ${(runRes.stderr || runRes.stdout).trim()}`;
      console.log(`MISMATCH ${stem}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\naccepted: ${accepted}/${files.length}`);
console.log(`matched: ${matched}/${accepted}`);
