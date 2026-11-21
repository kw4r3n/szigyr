// expect-output: v=1 3
// expect-output: n 7 n
// stage: 2
type R = { readonly kind: "a"; readonly x: i32 } | { readonly kind: "b"; readonly y: i32 };
function go(): i32 {
  "use rt";
  const n: null = null;
  if (n === null) { return 1; }
  return 2;
}
function go2(): i32 {
  "use rt";
  if (null === null) { return 3; }
  return 4;
}
function f(x: i32 | null): i32 | null {
  "use rt";
  if (x === null) { return x; }
  return 1;
}
function g(x: i32 | null): i32 {
  "use rt";
  if (x === null) { const y = x; return y === null ? 7 : 8; }
  return 1;
}
function h(r: R | null): R | null {
  "use rt";
  if (r === null) { return r; }
  return r;
}
export function main(sys: System): void {
  sys.log.info(`v=${go()} ${go2()}`);
  const a = f(null);
  const r: R | null = null;
  const c = h(r);
  sys.log.info(`${a === null ? "n" : "v"} ${g(null)} ${c === null ? "n" : "v"}`);
}
