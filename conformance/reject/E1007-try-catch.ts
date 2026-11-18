// expect: E1007 @ 4:3
// stage: 1
export function f(x: i32): i32 {
  try {
    return x;
  } catch (e) {
    return 0;
  }
}
