// expect: E6002 @ 8:12
// stage: 1
// open-question: Q056
function ping(log: Log): boolean {
  return true;
}
export function f(x: i32, log: Log): i32 {
  requires(ping(log));
  return x;
}
