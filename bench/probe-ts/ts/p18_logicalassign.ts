interface Cfg { name?: string; n?: number; on: boolean }
function main(): void {
  const c: Cfg = { on: false };
  c.name ??= "def";
  c.n ??= 5;
  c.n ??= 9;
  c.on ||= true;
  let z: number | undefined;
  z ??= 1;
  let k = 0;
  k ||= 7;
  console.log(c.name, c.n, c.on, z, k);
}
main();
