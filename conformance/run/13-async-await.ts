// expect-output: start
// expect-output: a=42
// expect-output: 3 2,4,6
// expect-output: total=20
// expect-output: end
// stage: 1
// open-question: Q027
// open-question: Q059
async function delayedDouble(x: i32): Promise<i32> {
  return x * 2;
}

async function total(xs: Array<i32>): Promise<i32> {
  let acc: i32 = 0;
  for (const x of xs) {
    acc += await delayedDouble(x);
  }
  return acc;
}

export async function main(sys: System): Promise<void> {
  sys.log.info("start");
  const a: i32 = await delayedDouble(21);
  sys.log.info(`a=${a}`);
  const all: Array<i32> = await Promise.all([delayedDouble(1), delayedDouble(2), delayedDouble(3)]);
  sys.log.info(`${all.length} ${all.join(",")}`);
  const t: i32 = await total([1, 2, 3, 4]);
  sys.log.info(`total=${t}`);
  sys.log.info("end");
}
