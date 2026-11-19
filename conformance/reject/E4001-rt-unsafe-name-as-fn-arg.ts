// expect: E4001 @ 15:17
// stage: 3
function helper(cb2: (x: i32) => i32, x: i32): i32 {
  "use owned";
  return cb2(x);
}
function rtu(x: i32): i32 {
  "use rt";
  "use unsafe";
  return x;
}
export function f(x: i32): i32 {
  "use owned";
  "use unsafe";
  return helper(rtu, x);
}
