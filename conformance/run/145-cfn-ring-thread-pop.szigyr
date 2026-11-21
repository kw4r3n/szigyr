// expect-output: 55
// stage: 3
// backend: c
// open-question: Q217
// open-question: Q218
declare module "c:stscb:stscb.h" {
  function stscb_start(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32, delay: i32, after: Ptr<(ud: Ptr<void>, x: i32) => i32>, aud: Ptr<void>): void;
  function stscb_join(ffi: Ffi): void;
}
import { stscb_start, stscb_join } from "c:stscb:stscb.h";

type State = Struct<{ rx: RingRx<i32>; sum: i32 }>;

function drain(s: Mut<State>): void {
  "use rt";
  let sum: i32 = 0;
  while (true) {
    const v = s.rx.pop();
    if (v === null) { continue; }
    if (v === -1) { break; }
    sum += v;
  }
  s.sum = sum;
}
function popper(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  const p = ud.cast<State>();
  drain(p.borrow());
  return 0;
}
function noop(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  return 0;
}
function arm(ffi: Ffi, alloc: Alloc, rx: RingRx<i32>): CHandle<State> {
  "use owned";
  "use unsafe";
  const st: State = { rx, sum: 0 };
  const p = Ptr.box(alloc, st);
  stscb_start(ffi, cfn(popper), p.cast<void>(), 0, 0, cfn(noop), p.cast<void>());
  return CHandle.create(p);
}
function readSum(s: Ref<State>): i32 {
  "use rt";
  return s.sum;
}
function finish(ffi: Ffi, h: CHandle<State>): i32 {
  "use owned";
  "use unsafe";
  stscb_join(ffi);
  const p = h.get();
  return readSum(p.borrow());
}
export function main(sys: System): void {
  const { tx, rx } = Ring.create<i32>(sys.alloc, 128);
  const h = arm(sys.ffi, sys.alloc, rx);
  let i: i32 = 1;
  while (i <= 10) {
    tx.push(i);
    i += 1;
  }
  tx.push(-1);
  const total = finish(sys.ffi, h);
  sys.log.info(`${total}`);
}
