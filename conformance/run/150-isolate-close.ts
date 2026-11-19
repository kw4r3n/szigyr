// expect-output: hello
// expect-output: closed
// expect-output: end
// stage: 3
function worker(port: Port<string, null>): void {
  port.send("hello");
}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(worker);
  const m = await p.recv();
  if (m !== null) {
    sys.log.info(m);
  }
  const end = await p.recv();
  sys.log.info(end === null ? "closed" : "open");
  p.send(null);
  p.close();
  p.close();
  sys.log.info("end");
}
