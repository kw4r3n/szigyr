// expect: E2002 @ 7:28
// stage: 1
// open-question: Q131
function f(): usize {
  let x: string | null = null;
  x = "d";
  const g = (): usize => x.length;
  x = null;
  return g();
}
