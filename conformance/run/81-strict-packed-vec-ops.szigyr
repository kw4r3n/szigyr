// expect-output: 10 45
// expect-output: 15 9 7 1
// expect-output: 4 0
// expect-output: 0 4 3 n 9
// expect-trap: T002 @ 46:12
// stage: 2
type V2 = Struct<{ readonly x: f32; readonly y: i16 }>;
type Lv = "lo" | "hi";

function sumY(s: Ref<Slice<V2>>): i32 {
  "use rt";
  let n: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) n += i32(s[i].y);
  return n;
}

function fillMid(s: Mut<Slice<V2>>, v: V2): void {
  "use rt";
  s.fill(v);
}

function work(v: Mut<Vec<V2>>): i32 {
  "use owned";
  fillMid(v.slice(2, 5), { x: 1, y: 7 });
  const p = v.pop();
  const last: i32 = p === null ? -1 : i32(p.y);
  return sumY(v.slice(1, 4)) * 100 + last;
}

function shrink(v: Mut<Vec<V2>>): usize {
  "use owned";
  v.clear();
  v.push({ x: 0, y: 0 });
  return v.length;
}

function lv(v: Ref<Vec<Lv | null>>, d: i32 | null): i32 {
  "use rt";
  let n: i32 = 0;
  for (let i: usize = 0; i < v.length; i += 1) { const e = v[i]; if (e !== null && e === "hi") n += 1; }
  return n + (d ?? 2);
}

function at(s: Ref<Slice<V2>>, i: usize): f32 {
  "use rt";
  return s[i].x;
}

export function main(sys: System): void {
  const v = Vec.create<V2>(sys.alloc, 1);
  for (let i: i16 = 0; i < 10; i += 1) v.push({ x: f32(i) * 0.5, y: i });
  sys.log.info(`${v.length} ${sumY(v)}`);
  const r = work(v);
  sys.log.info(`${divTrunc(r, 100)} ${rem(r, 100)} ${v[4].y} ${v[2].x}`);
  const ls = Vec.create<Lv | null>(sys.alloc, 1);
  ls.push("hi");
  ls.push(null);
  ls.push("lo");
  ls.push("hi");
  sys.log.info(`${ls.length} ${shrink(v) - 1}`);
  const d: i32 | null = null;
  sys.log.info(`${lv(ls, 0) - 2} ${lv(ls, d)} ${lv(ls, 1)} ${ls[1] === null ? "n" : "x"} ${v.length + 8}`);
  sys.log.info(`${at(v, 1)}`);
}
