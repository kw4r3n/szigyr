// expect-output: ok 10
// expect-output: err bad digit x
// expect-output: ok 0
// expect-output: ok 9
// stage: 1
// open-question: Q027
// open-question: Q031
// open-question: Q037
// open-question: Q059
function parseDigit(c: string): Result<i32, string> {
  const code: u16 = c.charCodeAt(0);
  if (code >= 48 && code <= 57) {
    return ok(i32(code) - 48);
  }
  return err(`bad digit ${c}`);
}

function sumDigits(s: string): Result<i32, string> {
  let total: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    const r = parseDigit(s.slice(i, i + 1));
    if (r.kind === "err") {
      return err(r.error);
    }
    total += r.value;
  }
  return ok(total);
}

function describe(r: Result<i32, string>): string {
  switch (r.kind) {
    case "ok":
      return `ok ${r.value}`;
    case "err":
      return `err ${r.error}`;
  }
}

export function main(sys: System): void {
  sys.log.info(describe(sumDigits("1234")));
  sys.log.info(describe(sumDigits("12x4")));
  sys.log.info(describe(sumDigits("")));
  sys.log.info(describe(parseDigit("9")));
}
