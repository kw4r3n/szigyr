// expect: E2005 @ 9:3
// stage: 1
// open-question: Q024
type Shape =
  | { readonly kind: "circle"; readonly r: f64 }
  | { readonly kind: "rect"; readonly w: f64; readonly h: f64 };
function f(s: Shape): f64 {
  let r: f64 = 0;
  switch (s.kind) {
    case "circle":
      r = s.r;
      break;
  }
  return r;
}
