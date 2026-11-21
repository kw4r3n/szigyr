// expect: ok
// stage: 2
// open-question: Q150
// open-question: Q043
// open-question: Q052
// open-question: Q013
function consume(v: Vec<f32>): usize {
  "use owned";
  return v.length;
}
function make(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
type Op = { readonly kind: "a" } | { readonly kind: "b" };
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
export function earlyReturn(alloc: Alloc, c: boolean): usize {
  "use owned";
  const a = make(alloc);
  if (c) {
    return consume(a);
  }
  return a.length;
}
export function moveThenBreak(alloc: Alloc, n: usize): usize {
  "use owned";
  const a = make(alloc);
  let r: usize = 0;
  for (let i: usize = 0; i < n; i += 1) {
    if (i === 2) {
      r = consume(a);
      break;
    }
  }
  return r;
}
export function returnInLoop(alloc: Alloc, n: usize): Vec<f32> {
  "use owned";
  const a = make(alloc);
  let i: usize = 0;
  while (true) {
    if (i >= n) {
      return a;
    }
    i += 1;
  }
}
export function caseMoves(alloc: Alloc, op: Op): usize {
  "use owned";
  const a = make(alloc);
  switch (op.kind) {
    case "a": return consume(a);
    case "b": return a.length;
  }
}
export function sliceRecv(v: Mut<Vec<f32>>): void {
  "use owned";
  v.slice(0, 1).fill(2);
}
export function wholeMove(b: Buf): usize {
  "use owned";
  const { data, rate } = b;
  return consume(data) + usize(rate);
}
export function relet(alloc: Alloc): Buf {
  "use owned";
  let d = make(alloc);
  const b: Buf = { data: d, rate: 1 };
  d = make(alloc);
  d.push(1);
  const c: Buf = { data: d, rate: b.rate };
  return c;
}
export function nested(alloc: Alloc, n: usize): usize {
  "use owned";
  let t: usize = 0;
  for (let i: usize = 0; i < n; i += 1) {
    let a = make(alloc);
    for (let j: usize = 0; j < n; j += 1) {
      t += consume(a);
      a = make(alloc);
    }
  }
  return t;
}
export function tern(alloc: Alloc, c: boolean): usize {
  "use owned";
  const a = make(alloc);
  const b = c ? a : make(alloc);
  return b.length;
}
