// expect: ok
// stage: 1
// open-question: Q009
// open-question: Q027
import { Rect, area, scaled } from "./geometry.ts";
import { clamp01 } from "./util.ts";

export function main(sys: System): void {
  const r: Rect = { w: 0.5, h: 3 };
  sys.log.info(`${area(scaled(r))} ${clamp01(2)}`);
}

test("imports", (t: Test) => {
  t.eq(area({ w: 2, h: 3 }), 6);
  t.eq(scaled({ w: 0.5, h: 3 }), { w: 1, h: 2 });
});
