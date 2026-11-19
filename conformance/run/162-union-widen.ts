// expect-output: a 1
// stage: 2
type U = { readonly kind: "a"; readonly x: i32 } | { readonly kind: "b" };
type V = { readonly kind: "a"; readonly x: i32 } | { readonly kind: "b" } | { readonly kind: "c" };
function f(u: U, k: boolean): V {
  "use rt";
  return u;
}
function g(x: i32): U {
  "use rt";
  const r: U = { kind: "a", x };
  return r;
}
function h(k: boolean): i32 {
  "use rt";
  return k ? 1 : 2;
}
export function main(sys: System): void {
  const v = f(g(3), true);
  sys.log.info(`${v.kind} ${h(true)}`);
}
