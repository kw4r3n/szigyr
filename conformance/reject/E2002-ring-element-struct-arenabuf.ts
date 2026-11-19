// expect: E2002 @ 5:30
// stage: 3
// open-question: Q210
type WithBuf = Struct<{ readonly b: ArenaBuf<i32>; readonly n: u32 }>;
export function f(tx: RingTx<WithBuf>): void {
}
