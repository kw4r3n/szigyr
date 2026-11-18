// expect: E2002 @ 6:53
// stage: 1
// open-question: Q130
async function g(): Promise<i32> { panic("lost"); }
function toMap<T>(f: () => T): Map<string, T> { const m = new Map<string, T>(); m.set("a", f()); return m; }
export function main(sys: System): void { const m = toMap(g); sys.log.info(`${m.size}`); }
