// expect-output: ok 3
// expect-output: err SyntaxError
// stage: 1
// open-question: Q035
function show(text: string): string {
  const r = JSON.parse(text);
  if (r.kind === "err") {
    return `err ${r.error.code}`;
  }
  const n = cast<u32>(r.value);
  if (n.kind === "err") {
    return "not u32";
  }
  return `ok ${n.value}`;
}
export function main(sys: System): void {
  sys.log.info(show("3"));
  sys.log.info(show("{"));
}
