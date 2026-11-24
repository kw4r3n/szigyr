class A { id = 1; }
class B extends A { tag = "b"; }
function what(x: A | string): string {
  if (x instanceof B) return "B " + x.tag;
  if (x instanceof A) return "A " + x.id;
  return "str " + x;
}
function main(): void {
  console.log(what(new A()), what(new B()), what("q"));
}
main();
