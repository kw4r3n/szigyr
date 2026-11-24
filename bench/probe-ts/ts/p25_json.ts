interface Item { id: number; tags: string[] }
function main(): void {
  const it: Item = { id: 1, tags: ["a", "b"] };
  const s = JSON.stringify(it);
  console.log(s);
  const back: unknown = JSON.parse(s);
  console.log(typeof back);
  console.log(JSON.stringify([1, "x", null, true]));
}
main();
