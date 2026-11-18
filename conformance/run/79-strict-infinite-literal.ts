// expect-output: Infinity -Infinity
// stage: 2
function f(a: f64): f64 { "use owned"; return a + 1e999; }
function g(a: f32): f32 { "use rt"; return a - 1e999; }
export function main(sys: System): void {
  sys.log.info(`${f(1)} ${g(1)}`);
}
