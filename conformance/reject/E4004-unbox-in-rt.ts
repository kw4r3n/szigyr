// expect: E4004 @ 7:12
// stage: 3
type S = Struct<{ x: i32 }>;
export function f(p: Ptr<S>): S {
  "use rt";
  "use unsafe";
  return p.unbox();
}
