// expect: ok
// stage: 3
function worker(port: Port<i32, i32>): void {
  port.send(1);
}

async function echo(port: Port<i32, i32>): Promise<void> {
  const v = await port.recv();
  if (v !== null) {
    port.send(v * 2);
  }
}

function closer(port: Port<null, null>): void {
  port.close();
}

export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(worker);
  p.send(21);
  const a = await p.recv();
  const q = sys.spawn.isolate(echo);
  q.send(2);
  const b = await q.recv();
  const r = sys.spawn.isolate<null, null>(closer);
  r.send(null);
  r.close();
}
