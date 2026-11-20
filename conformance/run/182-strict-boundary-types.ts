// expect-output: 5 7 -1 9
// expect-output: 3 4 6 12
// stage: 3
// open-question: Q233
// What may cross the managed / C boundary (Q233): `T | null` with a layout, Result of values, void, Struct, Handle, and a
// generic whose type parameter never crosses as `null` (an unused one may still be `null`).
type P = Struct<{ readonly x: i32; readonly y: i32 }>;
function opt(x: i32 | null): i32 | null { "use owned"; return x === null ? null : x + 1; }
function res(x: Result<i32, i32>): Result<i32, i32> { "use owned"; return x; }
function nothing(): void { "use owned"; }
function pt(p: P): P { "use owned"; return { x: p.y, y: p.x }; }
function id<T>(x: T): T { "use owned"; return x; }
function unused<T>(x: i32): i32 { "use owned"; return x + 1; }
function hd(h: Handle<i32> | null): i32 { "use owned"; return h === null ? 0 : 1; }
function make(a: Alloc): Handle<i32> | null { "use owned"; const p = Pool.create<i32>(a, 2); return p.insert(3); }
function show(v: i32 | null): i32 { if (v === null) { return -1; } return v; }
function rv(v: Result<i32, i32>): i32 { if (v.kind === "ok") { return v.value; } return -2; }
export function main(sys: System): void {
  const q = pt({ x: 1, y: 2 });
  sys.log.info(`${show(opt(4))} ${rv(res(ok(7)))} ${show(opt(null))} ${id<i32>(9)}`);
  nothing();
  sys.log.info(`${hd(make(sys.alloc)) + 2} ${q.x * 2} ${unused<null>(5)} ${rv(id<Result<i32, i32>>(ok(12)))}`);
}
