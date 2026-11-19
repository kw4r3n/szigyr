// expect: E4001 @ 10:10
// stage: 3
function rtu(x: i32): i32 {
  "use rt";
  "use unsafe";
  return x;
}
export function f(x: i32): i32 {
  "use rt";
  return rtu(x);
}
