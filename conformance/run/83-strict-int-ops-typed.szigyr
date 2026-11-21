// expect-output: 0 -2 -1 2 -3 1 0 7
// expect-output: 127 -128 0 255 65535 0
// expect-trap: T001 @ 17:10
// stage: 2
// The C backend checks +, -, *, divTrunc and rem in the operand type (D108); these are the edges.
function rems(a: i32, b: i32): i32 { "use rt"; return rem(a, b); }
function divs(a: i32, b: i32): i32 { "use rt"; return divTrunc(a, b); }
function i8add(a: i8, b: i8): i8 { "use rt"; return a + b; }
function i8sub(a: i8, b: i8): i8 { "use rt"; return a - b; }
function u8mul(a: u8, b: u8): u8 { "use rt"; return a * b; }
function u16sub(a: u16, b: u16): u16 { "use rt"; return a - b; }
function u32rem(a: u32, b: u32): u32 { "use rt"; return rem(a, b); }
function i8div(a: i8, b: i8): i8 { "use rt"; return divTrunc(a, b); }
function i8m1(a: i8): i8 {
  "use rt";
  const m: i8 = -1;
  return divTrunc(a, m);
}
export function main(sys: System): void {
  const mn: i32 = -2147483648;
  sys.log.info(`${rems(mn, -1)} ${rems(-7, 5)} ${divs(-7, 5)} ${divs(7, 3)} ${divs(-7, 2)} ${rems(7, -3)} ${u32rem(9, 3)} ${divs(-7, -1)}`);
  sys.log.info(`${i8add(100, 27)} ${i8sub(-100, 28)} ${i8div(0, -1)} ${u8mul(15, 17)} ${u16sub(65535, 0)} ${u32rem(0, 7)}`);
  sys.log.info(`${i8m1(-128)}`);
}
