// expect-output: 1 55296 true false true
// stage: 3
// open-question: Q238
export function main(sys: System): void {
  const s = "\ud800";
  let m = "\ud800";
  m = "x";
  sys.log.info(`${s.length} ${s.charCodeAt(0)} ${s === "\ud800"} ${s === m} ${"😀".length === 2}`);
}
