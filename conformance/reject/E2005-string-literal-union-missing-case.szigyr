// expect: E2005 @ 7:3
// stage: 1
// open-question: Q024
type Color = "red" | "green" | "blue";
function f(c: Color): f64 {
  let r: f64 = 0;
  switch (c) {
    case "red":
      r = 1;
      break;
    case "green":
      r = 2;
      break;
  }
  return r;
}
