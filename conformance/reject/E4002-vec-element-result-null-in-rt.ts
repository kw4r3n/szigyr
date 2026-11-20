// expect: E4002 @ 4:19
// stage: 3
// open-question: Q229
function count(v: Ref<Vec<Result<null, i32>>>): usize {
  "use rt";
  return v.length;
}
