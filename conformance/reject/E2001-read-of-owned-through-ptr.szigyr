// expect: E2001 @ 7:12
// stage: 3
type S = Struct<{ x: Vec<f32> }>;
export function f(p: Ptr<S>): S {
  "use owned";
  "use unsafe";
  return p.read();
}
