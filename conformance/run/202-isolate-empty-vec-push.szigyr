// expect-output: 2
// expect-output: 7
// expect-output: 8
// stage: 3
// An empty Vec sent to an isolate arrives with no room; push still grows it there.
async function worker(port: Port<i32, Vec<i32>>): Promise<void> {
  const v = await port.recv();
  if (v === null) {
    port.send(-1);
    return;
  }
  v.push(7);
  v.push(8);
  port.send(i32(v.length));
  port.send(v[0]);
  port.send(v[1]);
}
function orNeg(v: i32 | null): i32 {
  if (v === null) {
    return -1;
  }
  return v;
}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(worker);
  const v = Vec.create<i32>(sys.alloc, 0);
  p.send(v);
  sys.log.info(`${orNeg(await p.recv())}`);
  sys.log.info(`${orNeg(await p.recv())}`);
  sys.log.info(`${orNeg(await p.recv())}`);
}
