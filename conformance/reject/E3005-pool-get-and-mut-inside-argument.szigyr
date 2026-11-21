// expect: E3005 @ 10:19
// stage: 2
// open-question: Q170
function id(p: Mut<Pool<f32>>, h: Handle<f32>): Handle<f32> {
  "use rt";
  return h;
}
function f(p: Pool<f32>, h: Handle<f32>): f32 {
  "use owned";
  return p.get(id(p, h));
}
