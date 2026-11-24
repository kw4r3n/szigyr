interface User { name: string; age?: number }
function greet(u: User, greeting?: string): string {
  const g = greeting ?? "Hello";
  const a = u.age === undefined ? "unknown" : String(u.age);
  return `${g}, ${u.name} (${a})`;
}
function main(): void {
  console.log(greet({ name: "Ann" }));
  console.log(greet({ name: "Bob", age: 30 }, "Hi"));
}
main();
