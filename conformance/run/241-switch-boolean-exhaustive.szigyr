// expect-output: yes no 1 2
// stage: 2
// open-question: Q254
function word(b: boolean): string {
  switch (b) {
    case true: return "yes";
    case false: return "no";
  }
}
function code(b: boolean): i32 {
  "use owned";
  switch (b) {
    case true: return 1;
    case false: return 2;
  }
}
export function main(sys: System): void {
  sys.log.info(`${word(true)} ${word(false)} ${code(true)} ${code(false)}`);
}
