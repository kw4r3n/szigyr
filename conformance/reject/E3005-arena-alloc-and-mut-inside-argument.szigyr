// expect: E3005 @ 11:18
// stage: 2
// open-question: Q170
function n(a: Mut<Arena>): usize {
  "use rt";
  a.reset();
  return 1;
}
function f(a: Mut<Arena>): void {
  "use rt";
  a.alloc<f32>(n(a), 0);
}
