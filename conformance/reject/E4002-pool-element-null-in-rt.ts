// expect: E4002 @ 4:18
// stage: 3
// open-question: Q229
function fill(p: Mut<Pool<null>>): usize {
  "use rt";
  return p.length;
}
