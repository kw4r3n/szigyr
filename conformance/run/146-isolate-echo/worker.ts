export async function worker(port: Port<i32, i32>): Promise<void> {
  while (true) {
    const v = await port.recv();
    if (v === null) {
      return;
    }
    port.send(v * 2);
  }
}
