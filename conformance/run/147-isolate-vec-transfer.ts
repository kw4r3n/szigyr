// expect-output: 42
// stage: 3
function sum(s: Ref<Slice<i32>>): i32 {
  "use owned";
  let acc: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    acc += s[i];
  }
  return acc;
}
function orNeg(v: i32 | null): i32 {
  if (v === null) {
    return -1;
  }
  return v;
}
async function worker(port: Port<i32, Vec<i32>>): Promise<void> {
  const v = await port.recv();
  if (v === null) {
    port.send(-1);
    return;
  }
  port.send(sum(v));
}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(worker);
  const v = Vec.create<i32>(sys.alloc, 3);
  v.push(10);
  v.push(20);
  v.push(12);
  p.send(v);
  const r = await p.recv();
  sys.log.info(`${orNeg(r)}`);
}
