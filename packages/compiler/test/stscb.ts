// Builds the stscb fixture library (conformance/fixtures/stscb, stage 3-6) and puts its
// directory on PKG_CONFIG_PATH, so `c:` declarations naming the stscb package resolve.
// A build failure is not an error: the package simply stays missing and every case that
// needs it is skipped by the usual rule (conformance/README.md).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "../../../conformance/fixtures/stscb");
const buildDir = join(dir, ".build");
let done = false;

export function ensureStscb(): void {
  if (done) return;
  done = true;
  const so = join(buildDir, "libstscb.so");
  try {
    if (!existsSync(so) || !existsSync(join(buildDir, "stscb.h")) || !existsSync(join(buildDir, "stscb.pc"))) {
      mkdirSync(buildDir, { recursive: true });
      execFileSync("cc", ["-std=gnu11", "-O2", "-shared", "-fPIC", join(dir, "stscb.c"), "-o", so, "-lpthread"], { stdio: "pipe" });
      copyFileSync(join(dir, "stscb.pc"), join(buildDir, "stscb.pc"));
      copyFileSync(join(dir, "stscb.h"), join(buildDir, "stscb.h"));
    }
    const prev = process.env.PKG_CONFIG_PATH;
    process.env.PKG_CONFIG_PATH = prev ? `${buildDir}:${prev}` : buildDir;
  } catch { /* the package stays missing; its cases skip */ }
}
