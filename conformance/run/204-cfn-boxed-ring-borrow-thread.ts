// expect-output: 42
// expect-output: 7
// stage: 3
// backend: c
// open-question: Q217
// A ring endpoint boxed on its own (not inside a Struct) and borrowed on a C thread: the
// borrow reads only C memory (§14.4: a box holds no JS engine or host state).
declare module "c:stscb:stscb.h" {
  function stscb_thread(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32): i32;
}
import { stscb_thread } from "c:stscb:stscb.h";

function take(rx: Mut<RingRx<i32>>): i32 {
  "use rt";
  const v = rx.pop();
  if (v === null) { return -1; }
  return v;
}
function popper(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  const p = ud.cast<RingRx<i32>>();
  return take(p.borrow());
}
function popTwice(ffi: Ffi, rx: RingRx<i32>, alloc: Alloc): i32 {
  "use owned";
  "use unsafe";
  const p = Ptr.box(alloc, rx);
  const a = stscb_thread(ffi, cfn(popper), p.cast<void>(), 0);
  const b = stscb_thread(ffi, cfn(popper), p.cast<void>(), 0);
  const back = p.unbox();
  return a * 100 + b;
}
export function main(sys: System): void {
  const { tx, rx } = Ring.create<i32>(sys.alloc, 8);
  tx.push(42);
  tx.push(7);
  const r = popTwice(sys.ffi, rx, sys.alloc);
  sys.log.info(`${divTrunc(r, 100)}`);
  sys.log.info(`${rem(r, 100)}`);
}
