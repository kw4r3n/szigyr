// expect-output: armed
// expect-trap: T001 @ 15:12
// stage: 3
// backend: c
// open-question: Q217
declare module "c:stscb:stscb.h" {
  function stscb_start(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32, delay: i32, after: Ptr<(ud: Ptr<void>, x: i32) => i32>, aud: Ptr<void>): void;
}
import { stscb_start } from "c:stscb:stscb.h";

type State = Struct<{ tx: RingTx<i32> }>;

function boom(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  return x + 1;
}
function pushTx(s: Mut<State>): void {
  "use rt";
  s.tx.push(99);
}
function done(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  const p = ud.cast<State>();
  pushTx(p.borrow());
  return 0;
}
function arm(ffi: Ffi, alloc: Alloc, tx: RingTx<i32>): void {
  "use owned";
  "use unsafe";
  const st: State = { tx };
  const p = Ptr.box(alloc, st);
  stscb_start(ffi, cfn(boom), p.cast<void>(), 2147483647, 50, cfn(done), p.cast<void>());
}
async function tick(): Promise<void> {}
export async function main(sys: System): Promise<void> {
  const { tx, rx } = Ring.create<i32>(sys.alloc, 4);
  arm(sys.ffi, sys.alloc, tx);
  sys.log.info("armed");
  let i: i32 = 0;
  while (i < 5000000) {
    await tick();
    if (rx.pop() !== null) { break; }
    i += 1;
  }
  sys.log.info("after");
}
