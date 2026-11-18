// expect: E1005 @ 4:12
// stage: 1
function w(x: unknown): string {
  return x as string;
}
