// expect-output: ready
// expect-trap: T006 @ 6:3
// stage: 3
function worker(port: Port<string, null>): void {
  port.send("ready");
  panic("isolate failed");
}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(worker);
  const m = await p.recv();
  if (m !== null) {
    sys.log.info(m);
  }
  const end = await p.recv();
}
