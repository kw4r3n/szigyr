// expect-output: 1.5 -1 r n
// expect-output: 2011.5 r 4
// expect-output: r2.54
// stage: 2
// A tagged-union member literal stored as `T | null` (local, return, Vec element) goes into the union before the nullable (D104).
type Sh = { readonly kind: "c"; readonly r: f32 } | { readonly kind: "r"; readonly w: f64; readonly h: u8 };
function f(a: i32): f64 {
  "use rt";
  const e: Sh | null = a > 0 ? { kind: "c", r: 1.5 } : null;
  if (e === null) return -1;
  return e.kind === "c" ? f64(e.r) : e.w;
}
function g(a: i32): Sh | null { "use rt"; if (a > 0) return { kind: "r", w: 3, h: 1 }; return null; }
function fv(v: Mut<Vec<Sh | null>>): f64 {
  "use owned";
  v.push(null); v.push({ kind: "c", r: 1.5 }); v.push({ kind: "r", w: 2.5, h: 4 }); v.push(null);
  let s: f64 = 0;
  for (let i: usize = 0; i < v.length; i += 1) {
    const e = v[i];
    if (e === null) s += 1000;
    else switch (e.kind) { case "c": s += f64(e.r); break; case "r": s += e.w * f64(e.h); break; }
  }
  v[0] = { kind: "r", w: 1, h: 1 };
  return s;
}
function gv(v: Ref<Vec<Sh | null>>): string { const e = v[0]; return e === null ? "null" : e.kind; }
export function main(sys: System): void {
  const x = g(1); const y = g(0);
  sys.log.info(`${f(1)} ${f(0)} ${x === null ? "n" : x.kind} ${y === null ? "n" : y.kind}`);


  const v = Vec.create<Sh | null>(sys.alloc, 1);
  sys.log.info(`${fv(v)} ${gv(v)} ${v.length}`);
  const e = v[2];
  sys.log.info(e === null ? "n" : e.kind === "r" ? `r${e.w}${e.h}` : "c");
}
