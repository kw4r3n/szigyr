// expect-output: start
// expect-trap: T007 @ 7:10
// stage: 2
// open-question: Q002
function store(v: Mut<Vec<i32>>, i: usize, a: i32, b: i32): void {
  "use rt";
  v[i] = divTrunc(a, b);
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 1);
  v.push(0);
  sys.log.info("start");
  store(v, 5, 1, 0);
}
