// expect-output: 7
// stage: 3
// backend: c
type U = { readonly kind: "a"; readonly n: i32 } | { readonly kind: "b"; readonly n: i32 };
function go(alloc: Alloc): i32 {
  "use owned";
  "use unsafe";
  const p = Ptr.box<U>(alloc, { kind: "b", n: 7 });
  const u = p.unbox();
  if (u.kind === "a") {
    return 1;
  }
  return u.n;
}
export function main(sys: System): void {
  sys.log.info(`${go(sys.alloc)}`);
}
