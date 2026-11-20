// expect: E2002 @ 4:12
// stage: 3
// open-question: Q225
const { a, c }: { readonly a: i32; readonly b: i32 } = { a: 1, b: 2 };
