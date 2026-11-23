interface Counter { count: number; inc(): void; get(): number }
function make(): Counter {
  return {
    count: 0,
    inc() { this.count += 1; },
    get() { return this.count; },
  };
}
function main(): void {
  const c = make();
  c.inc(); c.inc();
  console.log(c.get());
}
main();
