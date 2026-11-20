// expect: E2002 @ 4:67
// stage: 3
// open-question: Q225
const { a, b }: { readonly a: i32; readonly b: i32 } = { a: 1, b: true };
