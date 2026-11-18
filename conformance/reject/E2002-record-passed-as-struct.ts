// expect: E2002 @ 11:7
// stage: 2
// open-question: Q002
type S = Struct<{ x: f64 }>;
function set(s: Mut<S>): void {
  "use owned";
  s.x = 1;
}
function f(): void {
  const r: { x: f64 } = { x: 0 };
  set(r);
}
