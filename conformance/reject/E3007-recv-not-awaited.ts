// expect: E3007 @ 6:21
// stage: 3
async function worker(port: Port<Vec<i32>, i32>): Promise<void> {}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(worker);
  const pending = p.recv();
}
