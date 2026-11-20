// expect: E2010 @ 6:25
// stage: 3
// open-question: Q236
type BadPort<T> = Port<Struct<{ x: T }>, i32>;
export function main(sys: System): void {}
function bad(p: BadPort<CHandle<void>>): void {}
