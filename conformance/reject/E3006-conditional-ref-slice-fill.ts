// expect: E3006 @ 6:15
// stage: 2
// open-question: Q050
function fillr(c: boolean, a: Ref<Slice<i32>>, b: Mut<Slice<i32>>): void {
  "use owned";
  (c ? a : b).fill(99);
}
