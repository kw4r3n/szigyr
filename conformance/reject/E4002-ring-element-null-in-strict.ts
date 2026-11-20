// expect: E4002 @ 4:20
// stage: 3
// open-question: Q229
function drain(rx: Mut<RingRx<null>>): boolean {
  "use owned";
  return rx.pop() === null;
}
