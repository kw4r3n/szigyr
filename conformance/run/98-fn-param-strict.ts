// expect-output: 42
// expect-output: 12 8
// stage: 2
function inc(x: i32): i32 {
  "use owned";
  return x + 1;
}
function dbl(x: i32): i32 {
  "use rt";
  return x + x;
}
function applyTwice(f: (x: i32) => i32, v: i32): i32 {
  "use owned";
  return f(f(v));
}
function sumWith(f: (x: i32) => i32, v: Mut<Slice<i32>>): i32 {
  "use owned";
  let acc: i32 = 0;
  for (let i: usize = 0; i < v.length; i += 1) {
    acc += f(v[i]);
  }
  return acc;
}
export function main(sys: System): void {
  const a = Vec.create<i32>(sys.alloc, 4);
  a.push(1); a.push(2); a.push(3);
  sys.log.info(`${applyTwice(inc, 40)}`);
  sys.log.info(`${sumWith(dbl, a)} ${applyTwice(dbl, 2)}`);
}
