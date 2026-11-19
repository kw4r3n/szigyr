// expect: E2002 @ 5:12
// stage: 1
export function f(): i32 {
  const x: i32 = 5;
  return x & "hello";
}
