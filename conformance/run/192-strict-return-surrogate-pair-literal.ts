// expect-output: {"kind":"😀","x":3} {"kind":"é","y":2.5}
// stage: 3
// open-question: Q238
type Sh = { readonly kind: "😀"; readonly x: i32 } | { readonly kind: "é"; readonly y: f64 };
function mk(n: i32): Sh {
  "use owned";
  if (n > 0) { return { kind: "😀", x: n }; }
  return { kind: "é", y: 2.5 };
}
export function main(sys: System): void {
  sys.log.info(`${JSON.stringify(mk(3))} ${JSON.stringify(mk(0))}`);
}
