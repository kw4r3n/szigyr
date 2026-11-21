// expect-output: 1 2 3 4
// stage: 3
// open-question: Q232
// A contract bans a builtin method by its receiver type, not by its name (Q232): user interface / class / record-field
// methods named like a banned builtin method are not E6002.
interface Cl { close(): boolean; push(x: i32): i32; recv(): i32 }
class Impl implements Cl {
  close(): boolean { return true; }
  push(x: i32): i32 { return x; }
  recv(): i32 { return 3; }
}
type Fns = { send: (x: i32) => i32; isolate: () => i32; set: (x: i32) => i32; insert: (x: i32) => i32 };
function a(c: Cl): i32 { requires(c.close()); requires(c.push(1) === 1); requires(c.recv() === 3); return 1; }
function b(f: Fns): i32 { requires(f.send(2) === 2); ensures((r: i32) => f.isolate() === 4 && r === 2); return 2; }
function d(f: Fns, c: Cl): i32 {
  let i = 0;
  while (i < 2) {
    invariant(f.set(3) === 3 && f.insert(7) === 7);
    invariant(c.push(5) === 5);
    i = i + 1;
  }
  return 3;
}
function m(c: Cl | null): i32 { requires(c !== null); return 4; }
export function main(sys: System): void {
  const c = new Impl();
  const f: Fns = { send: (x: i32): i32 => x, isolate: (): i32 => 4, set: (x: i32): i32 => x, insert: (x: i32): i32 => x };
  sys.log.info(`${a(c)} ${b(f)} ${d(f, c)} ${m(c)}`);
}
