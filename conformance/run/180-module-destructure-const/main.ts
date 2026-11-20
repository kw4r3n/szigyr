// expect-output: 640 480
// expect-output: 0.5 4
// expect-output: 307200
// expect-output: 1127
// expect-output: 7 true mod
// expect-output: 3
// stage: 3
// open-question: Q225
import { width, h } from "./reexport.ts";
import { gain, scaled, sum, px, py, flag, name } from "./consts.ts";
function area(): i32 {
  "use owned";
  return width * h;
}
function mix(v: f64): f64 {
  "use rt";
  return v * gain;
}
const { lo, hi }: { readonly lo: u8; readonly hi: u8 } = { lo: 1, hi: 2 };
export function main(sys: System): void {
  sys.log.info(`${width} ${h}`);
  sys.log.info(`${mix(1)} ${scaled(4)}`);
  sys.log.info(`${area()}`);
  sys.log.info(`${sum()}`);
  sys.log.info(`${px + py} ${flag} ${name}`);
  sys.log.info(`${lo + hi}`);
}
