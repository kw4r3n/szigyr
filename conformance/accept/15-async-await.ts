// expect: ok
// stage: 1
// open-question: Q022
// open-question: Q027
async function delayed(x: i32): Promise<i32> {
  return x * 2;
}

export async function pipeline(x: i32): Promise<i32> {
  const a = await delayed(x);
  const b = await delayed(a);
  return a + b;
}

export async function allOf(xs: Array<i32>): Promise<Array<i32>> {
  const r = await Promise.all(xs.map((x: i32) => delayed(x)));
  return r;
}

export async function main(sys: System): Promise<void> {
  const v = await pipeline(3);
  sys.log.info(`v=${v}`);
}

test("pipeline", async (t: Test) => {
  t.eq(await pipeline(1), 6);
  t.eq(await allOf([1, 2]), [2, 4]);
});
