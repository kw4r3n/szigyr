// expect: ok
// stage: 1
type R = { readonly a: string | null };
function closureReads(x: string | null): usize {
  if (x === null) return 0;
  const g = (): usize => x.length;
  return g();
}
function bothBranches(x: string | null, b: boolean, log: Log): usize {
  let y: i32 = 0;
  if (x !== null) {
    if (b) { y = 1; } else { y = 2; }
    log.info(`${y}`);
    return x.length;
  }
  return 0;
}
function earlyExit(r: R, log: Log): usize {
  let n: usize = 0;
  if (r.a === null) { return n; }
  n = 1;
  log.info(r.a);
  return r.a.length;
}
function loopExit(x0: string | null): usize {
  let x: string | null = x0;
  while (x === null) { x = "a"; }
  return x.length;
}
function closureAssignsOther(x: string | null, log: Log): usize {
  let other: i32 = 0;
  const g = (): void => { other = 1; };
  if (x !== null) { g(); log.info(`${other}`); return x.length; }
  return 0;
}
function elseReads(x0: string | null): usize {
  let x: string | null = x0;
  if (x === null) { x = "a"; } else { return x.length; }
  return 0;
}
function continueAfterAssign(xs: Array<string | null>, start: string): usize {
  let n: usize = 0;
  for (const v of xs) {
    let cur: string | null = v;
    if (cur === null) { cur = start; continue; }
    n += cur.length;
  }
  return n;
}
function ternaryElse(x0: string | null): boolean {
  let x: string | null = x0;
  return x === null ? (x = "a") === "a" : x.length > 0;
}
