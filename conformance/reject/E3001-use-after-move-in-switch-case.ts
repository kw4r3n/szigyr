// expect: E3001 @ 18:10
// stage: 2
// open-question: Q043
type Op = { readonly kind: "a" } | { readonly kind: "b" };
function consume(v: Vec<f32>): void {
  "use owned";
}
function f(alloc: Alloc, op: Op): usize {
  "use owned";
  const a = Vec.create<f32>(alloc, 4);
  switch (op.kind) {
    case "a":
      consume(a);
      break;
    case "b":
      break;
  }
  return a.length;
}
