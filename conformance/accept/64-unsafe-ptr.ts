// expect: ok
// stage: 3
declare module "c:foo:foo.h" {
  function make(ffi: Ffi, n: i32): Ptr<i32>;
  function put(ffi: Ffi, p: ConstPtr<i32>): void;
}
import { make, put } from "c:foo:foo.h";

type State = Struct<{ readonly phase: f32 }>;

function readFirst(s: Ref<Slice<i32>>): i32 {
  "use rt";
  return s[0];
}
function writeFirst(s: Mut<Slice<i32>>): void {
  "use rt";
  s[0] = 7;
}
export function open(ffi: Ffi): CHandle<i32> {
  "use owned";
  "use unsafe";
  const p = make(ffi, 4);
  if (!p.isNull()) {
    p.write(41);
    const q: ConstPtr<i32> = p;
    put(ffi, q);
    const r = readFirst(p.slice(2));
    const s2 = p.offset(1).read();
    writeFirst(p.slice(2));
    const cp = p.cast<f32>();
    const empty = cp.isNull();
    if (r === s2 && !empty) {
      p.write(r);
    }
  }
  return CHandle.create(p);
}
export function roundTrip(alloc: Alloc, s: State): State {
  "use owned";
  "use unsafe";
  const p = Ptr.box(alloc, s);
  return p.unbox();
}
