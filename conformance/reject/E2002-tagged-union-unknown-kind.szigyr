// expect: E2002 @ 8:20
// stage: 1
// open-question: Q021
type Shape =
  | { readonly kind: "circle"; readonly r: f64 }
  | { readonly kind: "rect"; readonly w: f64; readonly h: f64 };
function f(): Shape {
  const s: Shape = { kind: "tri", r: 1 };
  return s;
}
