// expect: ok
// stage: 1
function a19(): string {
  let x: string | null = null;
  if (x === null) { x = "d"; }
  return x.trim();
}
function a07(): string {
  let x: string | null = null;
  x = x ?? "d";
  return x.trim();
}
function a18(log: Log): void {
  let cache: string | null = null;
  for (let i: i32 = 0; i < 2; i += 1) {
    if (cache === null) { cache = "v"; }
    log.info(cache.trim());
  }
}
