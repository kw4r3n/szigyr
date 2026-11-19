// expect: E3006 @ 7:5
// stage: 2
// open-question: Q050
// open-question: Q188
function f(a: Ref<Arena>, n: usize): void {
  "use rt";
  a.alloc<f32>(n, 0);
}
