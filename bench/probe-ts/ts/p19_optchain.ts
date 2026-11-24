interface Node1 { val: number; next?: Node1 }
function pickNone(xs: number[]): number[] | undefined { return xs.length > 5 ? xs : undefined; }
function main(): void {
  const list: Node1 = { val: 1, next: { val: 2 } };
  console.log(list.next?.val, list.next?.next?.val);
  const arr: number[] | undefined = [1, 2, 3];
  const none = pickNone([1]);
  console.log(arr?.[1], none?.[0]);
  const f: (() => number) | undefined = () => 42;
  console.log(f?.());
}
main();
