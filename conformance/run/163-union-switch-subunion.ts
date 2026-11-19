// expect-output: v=9
// stage: 2
type U = { readonly kind: "a"; readonly x: i32 } | { readonly kind: "b"; readonly y: i32 } | { readonly kind: "c"; readonly z: i32 };
type AB = { readonly kind: "a"; readonly x: i32 } | { readonly kind: "b"; readonly y: i32 };
function ab(r: AB): i32 {
  "use rt";
  switch (r.kind) { case "a": return r.x; case "b": return r.y; }
}
function go(r: U): i32 {
  "use rt";
  switch (r.kind) {
    case "a":
    case "b":
      return ab(r);
    case "c":
      return r.z;
  }
}
export function main(sys: System): void {
  const r: U = { kind: "b", y: 9 };
  sys.log.info(`v=${go(r)}`);
}
