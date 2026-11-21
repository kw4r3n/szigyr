// Builds the szcb fixture library (conformance/fixtures/szcb, stage 3-6) and puts its
// directory on PKG_CONFIG_PATH, so `c:` declarations naming the szcb package resolve.
// A build failure is not an error: the package simply stays missing and every case that
// needs it is skipped by the usual rule (conformance/README.md).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "../../../conformance/fixtures/szcb");
const buildDir = join(dir, ".build");
let done = false;

export function ensureSzcb(): void {
  if (done) return;
  done = true;
  const so = join(buildDir, "libszcb.so");
  try {
    if (!existsSync(so) || !existsSync(join(buildDir, "szcb.h")) || !existsSync(join(buildDir, "szcb.pc"))) {
      mkdirSync(buildDir, { recursive: true });
      execFileSync("cc", ["-std=gnu11", "-O2", "-shared", "-fPIC", join(dir, "szcb.c"), "-o", so, "-lpthread"], { stdio: "pipe" });
      copyFileSync(join(dir, "szcb.pc"), join(buildDir, "szcb.pc"));
    }
    for (const h of readdirSync(dir).filter((x) => x.endsWith(".h"))) copyFileSync(join(dir, h), join(buildDir, h)); // header-only additions need no rebuild
    const prev = process.env.PKG_CONFIG_PATH;
    process.env.PKG_CONFIG_PATH = prev ? `${buildDir}:${prev}` : buildDir;
  } catch { /* the package stays missing; its cases skip */ }
}
