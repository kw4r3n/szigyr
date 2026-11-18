// expect-output: 4 -5 200 true -300 a 0.10000000149011612 255 -5
// expect-output: 1 false -1 7 1 false
// stage: 2
// Generic strict functions that create and return Vec<T> are monomorphized in C (D100, D104).
type P = Struct<{ readonly x: i32; readonly y: u8 }>;
type U = { readonly kind: "a"; readonly n: i16 } | { readonly kind: "b" };
function mk<T>(a: Alloc, x: T, n: usize): Vec<T> { "use owned"; const v = Vec.create<T>(a, 1); for (let i: usize = 0; i < n; i += 1) v.push(x); return v; }
function mk2<T>(a: Alloc, x: T): Vec<T> { "use owned"; const v = mk<T>(a, x, 3); v.push(x); return v; }
function rd<T>(v: Ref<Vec<T>>, i: usize): T { "use owned"; return v[i]; }
function rdu(v: Ref<Vec<U>>, i: usize): i32 { "use owned"; const u = v[i]; return u.kind === "a" ? i32(u.n) : -1; }
export function main(sys: System): void {
  const a = mk2<P>(sys.alloc, { x: -5, y: 200 });
  const b = mk2<boolean>(sys.alloc, true);
  const c = mk2<U>(sys.alloc, { kind: "a", n: -300 });
  const d = mk2<f32>(sys.alloc, 0.1);
  const e = mk2<u8>(sys.alloc, 255);
  sys.log.info(`${a.length} ${a[3].x} ${a[3].y} ${b[2]} ${rdu(c, 3)} ${rd(c, 1).kind} ${d[2]} ${e[3]} ${rd(a, 2).x}`);
  a.push({ x: 1, y: 1 }); b.push(false); c.push({ kind: "b" }); d.push(7); e.push(1);
  sys.log.info(`${a[4].x} ${b[4]} ${rdu(c, 4)} ${d[4]} ${e[4]} ${rd(b, 4)}`);
}
