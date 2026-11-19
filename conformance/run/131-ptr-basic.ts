// expect-output: 41 9 9 5 6
// stage: 3
// backend: c
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_malloc(ffi: Ffi, n: i32): Ptr<void>;
}
import { sqlite3_malloc } from "c:sqlite3:sqlite3.h";
type R = Struct<{ a: i32; b: i32; c: i32; d: i32; e: i32 }>;
function fill(s: Mut<Slice<i32>>): void {
  "use rt";
  s.fill(9);
}
function go(alloc: Alloc, ffi: Ffi): R {
  "use owned";
  "use unsafe";
  const p = Ptr.box<i32>(alloc, 40);
  p.write(41);
  const a = p.read();
  fill(p.slice(1));
  const b = p.read();
  const c = p.unbox();
  const m = sqlite3_malloc(ffi, 16).cast<i32>();
  m.write(5);
  m.offset(1).write(6);
  const d = m.read();
  const e = m.offset(1).read();
  return { a, b, c, d, e };
}
export function main(sys: System): void {
  const r = go(sys.alloc, sys.ffi);
  sys.log.info(`${r.a} ${r.b} ${r.c} ${r.d} ${r.e}`);
}
