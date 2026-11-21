// expect: E6002 @ 4:14
// stage: 2
export function f(p: Mut<Pool<i32>>): i32 {
  requires(p.insert(1) !== null);
  return 1;
}
