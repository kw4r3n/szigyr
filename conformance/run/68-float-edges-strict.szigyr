// expect-output: 3 -2 0 -Infinity -Infinity Infinity -Infinity NaN
// expect-output: 1.0000001192092896 0.3333333432674408 -1.5 1.4142135623730951 -1 16777216
// stage: 2
function rounds(a: f64, b: f64, c: f64, d: f64): f64 {
  "use rt";
  return Math.round(a) + Math.round(b) * 0 + Math.round(c) * 0 + d * 0;
}

function round1(x: f64): f64 {
  "use rt";
  return Math.round(x);
}

function inv(x: f64): f64 {
  "use rt";
  return 1 / x;
}

function minZero(): f64 {
  "use rt";
  return 1 / Math.min(0, -0);
}

function maxZero(): f64 {
  "use rt";
  return 1 / Math.max(-0, 0);
}

function signZero(): f64 {
  "use rt";
  return 1 / Math.sign(-0);
}

function minNaN(x: f64): f64 {
  "use rt";
  return Math.min(x, 1);
}

function sum10(): f32 {
  "use rt";
  let s: f32 = 0;
  for (let i: i32 = 0; i < 10; i += 1) {
    s += 0.1;
  }
  return s;
}

function third(a: f32, b: f32): f32 {
  "use rt";
  return a / b;
}

function misc(a: f64, b: f64): f64 {
  "use rt";
  return a % b;
}

function bigF32(a: f32): f32 {
  "use rt";
  return a + 1;
}

export function main(sys: System): void {
  sys.log.info(`${rounds(2.5, 0, 0, 0)} ${round1(-2.5)} ${round1(0.49999999999999994)} ${inv(round1(-0.4))} ${minZero()} ${maxZero()} ${signZero()} ${minNaN(0 / 0)}`);
  sys.log.info(`${sum10()} ${third(1, 3)} ${misc(-5.5, 2)} ${Math.sqrt(2)} ${Math.trunc(-1.7)} ${bigF32(16777216)}`);
}
