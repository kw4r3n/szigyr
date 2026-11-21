// expect-output: Infinity -Infinity NaN true true
// stage: 3
// open-question: Q271
function f(x: f64): f64 {
  "use rt";
  return x + Number.POSITIVE_INFINITY;
}
function g(x: f64): f64 {
  "use rt";
  return x + Number.NEGATIVE_INFINITY;
}
function h(): f64 {
  "use rt";
  return Number.NaN;
}
export function main(sys: System): void {
  sys.log.info(`${f(1)} ${g(1)} ${h()} ${f(0) === Number.POSITIVE_INFINITY} ${Number.EPSILON < 1e-15 && Number.MAX_SAFE_INTEGER === 9007199254740991}`);
}
