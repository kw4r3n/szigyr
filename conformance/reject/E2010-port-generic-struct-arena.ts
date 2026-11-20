// expect: E2010 @ 7:25
// stage: 3
// open-question: Q236
type BadPort<T> = Port<Struct<{ x: T }>, i32>;
function sink(p: BadPort<i32>): void {}
export function main(sys: System): void {}
function bad(p: BadPort<Arena>): void {}
