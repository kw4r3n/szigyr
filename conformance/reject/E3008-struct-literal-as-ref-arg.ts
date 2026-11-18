// expect: E3008 @ 11:13
// stage: 2
// open-question: Q002
type P = Struct<{ x: f32 }>;
function rd(p: Ref<P>): f32 {
  "use owned";
  return p.x;
}
function f(): f32 {
  "use owned";
  return rd({ x: 1 });
}
