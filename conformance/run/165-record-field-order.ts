// expect-output: v=3 n=7 m=8
// stage: 2
type A = Struct<{ readonly x: i32; readonly y: i32 }>;
type B = Struct<{ readonly y: i32; readonly x: i32 }>;
type R1 = { readonly kind: "a"; readonly x: i32 } | { readonly kind: "b"; readonly y: i32 };
type R2 = { readonly kind: "b"; readonly y: i32 } | { readonly kind: "a"; readonly x: i32 };
function conv(a: A): B {
  "use rt";
  return a;
}
function n1(r: R1 | null): R2 | null {
  "use rt";
  return r;
}
function n2(r: null | R2): i32 {
  "use rt";
  if (r === null) { return 0; }
  switch (r.kind) {
    case "a": return r.x;
    case "b": return r.y;
  }
}
function go(): i32 {
  "use rt";
  const a: A = { x: 1, y: 2 };
  const b = conv(a);
  return b.x + b.y;
}
function go2(k: i32): i32 {
  "use rt";
  const r: R1 = { kind: "b", y: k };
  return n2(n1(r));
}
export function main(sys: System): void {
  sys.log.info(`v=${go()} n=${go2(7)} m=${go2(8)}`);
}
