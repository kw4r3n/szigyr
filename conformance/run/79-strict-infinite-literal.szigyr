// expect-output: Infinity -Infinity
// stage: 2
// open-question: Q255
// the literal `1e999` is E2008 now; the infinities come from a division by zero
function f(a: f64): f64 { "use owned"; return a / 0; }
function g(a: f32): f32 { "use rt"; return -a / 0; }
export function main(sys: System): void {
  sys.log.info(`${f(1)} ${g(1)}`);
}
