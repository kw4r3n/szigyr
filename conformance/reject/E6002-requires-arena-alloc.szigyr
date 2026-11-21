// expect: E6002 @ 4:15
// stage: 2
export function a(ar: Mut<Arena>): i32 {
  requires(ar.alloc<i32>(4, 0) !== null);
  return 1;
}
