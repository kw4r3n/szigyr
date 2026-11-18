// expect: E3006 @ 7:3
// stage: 2
// open-question: Q050
type P = Struct<{ x: f32 }>;
function g(s: Ref<P>): void {
  "use owned";
  s.x = 1;
}
