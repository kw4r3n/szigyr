// expect: E4002 @ 5:22
// stage: 3
// open-question: Q238
type Sh = { readonly kind: "\ud800"; readonly x: i32 } | { readonly kind: "�"; readonly y: f64 };
function mk(n: i32): Sh {
  "use owned";
  if (n > 0) { return { kind: "\ud800", x: n }; }
  return { kind: "�", y: 2.5 };
}
export function main(sys: System): void {
  sys.log.info(`${JSON.stringify(mk(1))}`);
}
