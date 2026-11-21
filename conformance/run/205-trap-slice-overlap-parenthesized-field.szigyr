// expect-output: start
// expect-trap: T013 @ 10:33
// stage: 2
// open-question: Q239
type S = Struct<{ a: Vec<i32> }>;
type P = Struct<{ a: Vec<i32>; s: S }>;
function cp(d: Mut<Slice<i32>>, s: Ref<Slice<i32>>): void { "use rt"; d[0] = s[0]; }
function g(p: Mut<P>): void {
  "use rt";
  cp((p.s).a.slice(0, 2), p.s.a.slice(1, 3));
}
export function main(sys: System): void {
  const a = Vec.create<i32>(sys.alloc, 4); a.push(1); a.push(2); a.push(3);
  const b = Vec.create<i32>(sys.alloc, 4); b.push(1); b.push(2); b.push(3);
  const p: P = { a, s: { a: b } };
  sys.log.info("start");
  g(p);
  sys.log.info("unreached");
}
