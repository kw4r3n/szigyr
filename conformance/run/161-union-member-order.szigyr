// expect-output: v=5
// stage: 2
type R1 = { readonly kind: "a"; readonly x: i32 } | { readonly kind: "b"; readonly y: i32 };
type R2 = { readonly kind: "b"; readonly y: i32 } | { readonly kind: "a"; readonly x: i32 };
function conv(r: R1): R2 {
  "use rt";
  return r;
}
function val(r: R2): i32 {
  "use rt";
  switch (r.kind) {
    case "a": return r.x;
    case "b": return r.y;
  }
}
function go(): i32 {
  "use rt";
  const r: R1 = { kind: "a", x: 5 };
  return val(conv(r));
}
export function main(sys: System): void {
  sys.log.info(`v=${go()}`);
}
