class Animal {
  constructor(public name: string) {}
  speak(): string { return `${this.name} makes a sound`; }
}
class Dog extends Animal {
  private _age = 1;
  get age(): number { return this._age; }
  set age(v: number) { this._age = v < 0 ? 0 : v; }
  speak(): string { return `${this.name} barks`; }
}
function main(): void {
  const d = new Dog("Rex");
  d.age = -5;
  console.log(d.speak(), d.age);
  d.age = 4;
  console.log(d.age);
  const a: Animal = new Animal("Cat");
  console.log(a.speak());
}
main();
