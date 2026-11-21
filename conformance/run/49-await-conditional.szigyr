// expect-output: 10
// expect-output: 15
// expect-output: 21
// stage: 1
// open-question: Q130
async function two(x: i32): Promise<i32> {
  return x * 2;
}
async function three(x: i32): Promise<i32> {
  return x * 3;
}
async function pick(c: boolean, x: i32): Promise<i32> {
  return await (c ? two(x) : three(x));
}
export async function main(sys: System): Promise<void> {
  sys.log.info(`${await pick(true, 5)}`);
  sys.log.info(`${await pick(false, 5)}`);
  sys.log.info(`${await (false ? two(1) : (true ? three(7) : two(0)))}`);
}
