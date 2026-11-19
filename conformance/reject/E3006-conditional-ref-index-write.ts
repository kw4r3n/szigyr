// expect: E3006 @ 6:3
// stage: 2
// open-question: Q050
function poke(c: boolean, a: Ref<Vec<i32>>, b: Ref<Vec<i32>>): void {
  "use owned";
  (c ? a : b)[0] = 99;
}
