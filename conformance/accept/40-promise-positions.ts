// expect: ok
// stage: 1
async function g(x: i32): Promise<i32> {
  return x;
}
function pass(x: i32): Promise<i32> {
  return g(x);
}
async function all(xs: Array<i32>): Promise<i32> {
  const a = await Promise.all([g(1), pass(2)]);
  const b = await Promise.all(xs.map((x: i32) => g(x)));
  const h = (x: i32) => g(x);
  const k = (x: i32): Promise<i32> => g(x);
  return a[0] + i32(b.length) + (await h(1)) + (await k(2)) + (await (g(3)));
}
test("async test", async (t: Test) => {
  t.eq(await all([1]), 8);
});
