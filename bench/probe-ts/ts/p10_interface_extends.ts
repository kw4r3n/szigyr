interface Named { name: string }
interface Aged extends Named { age: number }
function desc(a: Aged): string { return `${a.name}/${a.age}`; }
function main(): void {
  const a: Aged = { name: "Zed", age: 7 };
  const n: Named = a;
  console.log(desc(a), n.name);
}
main();
