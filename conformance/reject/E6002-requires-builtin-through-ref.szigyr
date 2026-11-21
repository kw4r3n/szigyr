// expect: E6002 @ 6:14
// stage: 3
// open-question: Q232
function f(v: Ref<Vec<i32>>): i32 {
  "use owned";
  requires(v.pop() === null);
  return 1;
}
