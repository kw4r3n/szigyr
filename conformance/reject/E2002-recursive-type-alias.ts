// expect: E2002 @ 4:31
// stage: 1
// open-question: Q085
type Chain = { readonly next: Chain | null };
