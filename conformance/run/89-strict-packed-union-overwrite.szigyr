// expect-output: 1507 2509
// stage: 2
// A union element is read, then overwritten with another member at the same offsets; the copy read first is unchanged (D105).
type U = { readonly kind: "f"; readonly x: f32 } | { readonly kind: "i"; readonly n: i32 };
function swap(v: Mut<Vec<U>>, k: usize): f64 {
  "use rt";
  const e = v[k];
  v[k] = { kind: "i", n: 7 };
  const g = v[k];
  let r: f64 = 0;
  if (e.kind === "f") r += f64(e.x) * 1000;
  if (g.kind === "i") r += f64(g.n);
  return r;
}
function back(v: Mut<Vec<U>>, k: usize): f64 {
  "use rt";
  const e = v[k];
  v[k] = { kind: "f", x: 2.5 };
  const g = v[k];
  let r: f64 = 0;
  if (e.kind === "i") r += f64(e.n) + 2;
  if (g.kind === "f") r += f64(g.x) * 1000;
  return r;
}
export function main(sys: System): void {
  const v = Vec.create<U>(sys.alloc, 1);
  v.push({ kind: "f", x: 1.5 });
  const a = swap(v, 0);
  const b = back(v, 0);
  sys.log.info(`${a} ${b}`);
}
