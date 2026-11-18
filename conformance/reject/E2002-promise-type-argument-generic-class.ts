// expect: E2002 @ 7:53
// stage: 1
// open-question: Q130
async function g(): Promise<i32> { panic("lost"); }
class Box<T> { v: T; constructor(v: T) { this.v = v; } }
function mk<T>(f: () => T): Box<T> { return new Box(f()); }
export function main(sys: System): void { const b = mk(g); sys.log.info("done"); }
