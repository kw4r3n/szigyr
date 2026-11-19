// expect: E1009 @ 5:5
// stage: 3
export function g(): (x: i32) => i32 {
  const f = function (x: i32): i32 {
    "use unsafe";
    return x;
  };
  return f;
}
