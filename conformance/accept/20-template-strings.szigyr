// expect: ok
// stage: 1
// open-question: Q027
// open-question: Q016
// open-question: Q032
export function label(name: string, n: usize, flag: boolean): string {
  return `${name}:${n}:${flag}`;
}

export function pad(n: u32): string {
  return `${n}`.padStart(3, "0");
}

export function shout(s: string): string {
  return `${s.toUpperCase()}!`;
}

export function nested(a: i32): string {
  return `a=${a} b=${`<${a + 1}>`}`;
}

export function initials(s: string): string {
  const parts = s.trim().split(" ");
  let out = "";
  for (const p of parts) {
    if (p.length > 0) {
      out = `${out}${p.slice(0, 1).toUpperCase()}`;
    }
  }
  return out;
}

test("templates", (t: Test) => {
  t.eq(label("x", 3, true), "x:3:true");
  t.eq(pad(7), "007");
  t.eq(shout("hi"), "HI!");
  t.eq(nested(1), "a=1 b=<2>");
  t.eq(initials("  ada lovelace "), "AL");
});
