// expect-output: 3
// stage: 3
// open-question: Q232
// A static method of a user class named like a banned builtin method is not E6002 in a contract (Q232).
class G {
  static send(x: i32): i32 { return x; }
  static close(): boolean { return true; }
  static push(x: i32): i32 { return x + 1; }
}
function f(x: i32): i32 { requires(G.send(x) === x); requires(G.close()); requires(G.push(x) === x + 1); return x; }
export function main(sys: System): void {
  sys.log.info(`${f(3)}`);
}
