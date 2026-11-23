async function delayed(x: number): Promise<number> {
  await Promise.resolve();
  return x * 2;
}
async function main(): Promise<void> {
  const a = await delayed(1);
  const rs = await Promise.all([delayed(2), delayed(3), delayed(4)]);
  console.log(a, rs.join(","));
  try {
    await Promise.reject(new Error("boom"));
  } catch (e) {
    if (e instanceof Error) console.log(e.message);
  }
}
main();
