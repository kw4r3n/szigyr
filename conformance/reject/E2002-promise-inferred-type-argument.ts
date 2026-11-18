// expect: E2002 @ 6:43
// stage: 1
// open-question: Q130
async function g(): Promise<i32> { panic("lost"); }
function app<T>(f: () => T): void { f(); }
export function main(sys: System): void { app(g); sys.log.info("done"); }
