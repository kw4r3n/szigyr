// expect-output: 3.5 1.5 5
// expect-output: 4 3 2
// stage: 2
// Vecs made in a managed generic function (a plain array in JS, D100) reach C as Slices and as Vecs (D105).
type P = Struct<{ readonly a: i32; readonly on: boolean }>;
function mk<T>(alloc: Alloc, a: T, b: T): Vec<T> {
  const v = Vec.create<T>(alloc, 2);
  v.push(a);
  v.push(b);
  v.push(a);
  return v;
}
function sum(s: Ref<Slice<f32>>): f32 {
  "use rt";
  let n: f32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) n += s[i];
  return n;
}
function bump(s: Mut<Slice<f32>>): void {
  "use rt";
  for (let i: usize = 0; i < s.length; i += 1) s[i] += 1;
}
function count(x: Ref<Slice<P>>, y: Ref<Slice<P>>): i32 {
  "use rt";
  let n: i32 = 0;
  for (let i: usize = 0; i < x.length; i += 1) if (x[i].on) n += x[i].a;
  for (let i: usize = 0; i < y.length; i += 1) if (y[i].on) n += y[i].a;
  return n;
}
function lenOf(v: Ref<Vec<P>>): usize {
  "use rt";
  return v.length;
}
export function main(sys: System): void {
  const v = mk<f32>(sys.alloc, 0.5, 2);
  bump(v.slice(1, 3));
  sys.log.info(`${sum(v.slice(0, 2))} ${v[2]} ${sum(v)}`);
  const ps = mk<P>(sys.alloc, { a: 1, on: true }, { a: 2, on: false });
  const qs = mk<P>(sys.alloc, { a: 1, on: true }, { a: 2, on: true });
  sys.log.info(`${count(ps.slice(0, 3), ps.slice(1, 3)) + 1} ${lenOf(qs)} ${count(qs.slice(1, 2), qs.slice(2, 2))}`);
}
