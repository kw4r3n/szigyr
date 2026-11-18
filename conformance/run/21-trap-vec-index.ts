// expect-output: 1 9
// expect-trap: T002 @ 9:5
// stage: 2
// open-question: Q002
// open-question: Q047
// open-question: Q059
function setAt(v: Mut<Vec<i32>>, i: usize, x: i32): void {
  "use owned";
  v[i] = x;
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 4);
  v.push(1);
  v.push(2);
  setAt(v, 1, 9);
  sys.log.info(`${v[0]} ${v[1]}`);
  const n: usize = v.length;
  setAt(v, n, 5);
  sys.log.info("unreachable");
}
