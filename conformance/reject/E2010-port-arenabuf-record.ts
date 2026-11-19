// expect: E2010 @ 3:23
// stage: 3
function sink(p: Port<{ readonly b: ArenaBuf<f32> }, i32>): void {}
export function main(sys: System): void {}
