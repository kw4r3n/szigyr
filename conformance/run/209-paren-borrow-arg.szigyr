// expect-output: 20
// stage: 3
// backend: c
// D157: a parenthesized borrowed argument or receiver is the same as the bare form
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_malloc(ffi: Ffi, n: i32): Ptr<void>;
}
import { sqlite3_malloc } from "c:sqlite3:sqlite3.h";
type P = Struct<{ x: i32 }>;
function getx(p: Ref<P>): i32 {
  "use rt";
  return p.x;
}
function sum(t: Ref<Slice<i32>>): i32 {
  "use rt";
  return t[0];
}
function go(ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  const np = sqlite3_malloc(ffi, 16).cast<i32>();
  np.write(5);
  const q = np.cast<P>();
  const a = getx((q.borrow()));
  const b = sum((np.slice(1)));
  const c = getx(((q).borrow()));
  const d = sum((np).slice(1));
  return a + b + c + d;
}
export function main(sys: System): void {
  sys.log.info(`${go(sys.ffi)}`);
}
