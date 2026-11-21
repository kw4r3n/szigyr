// expect-output: NaN NaN NaN Infinity 0
// expect-output: -Infinity NaN -Infinity 1.5707963267948966 1 -1
// expect-output: 3.141592653589793 -3.141592653589793 0 3.141592653589793 1.5707963267948966 1.5707963267948966 -1.5707963267948966
// expect-output: Infinity -Infinity -Infinity Infinity Infinity -Infinity Infinity
// expect-output: NaN NaN NaN 1 -Infinity -Infinity -Infinity 1
// stage: 2
export function main(sys: System): void {
  const nan: f64 = 0 / 0;
  const inf: f64 = 1 / 0;
  sys.log.info(`${DetMath.sin(inf)} ${DetMath.cos(-inf)} ${DetMath.tan(nan)} ${DetMath.exp(inf)} ${DetMath.exp(-inf)}`);
  sys.log.info(`${DetMath.log(0)} ${DetMath.log(-1)} ${DetMath.log10(0)} ${DetMath.atan(inf)} ${DetMath.tanh(inf)} ${DetMath.tanh(-inf)}`);
  sys.log.info(`${DetMath.atan2(0, -1)} ${DetMath.atan2(-0, -1)} ${DetMath.atan2(0, 0)} ${DetMath.atan2(0, -0)} ${DetMath.atan2(1, 0)} ${DetMath.atan2(1, -0)} ${DetMath.atan2(-1, 0)}`);
  sys.log.info(`${1 / DetMath.atan2(0, 1)} ${1 / DetMath.atan2(-0, 1)} ${1 / DetMath.pow(-0, 3)} ${1 / DetMath.pow(-0, 2)} ${DetMath.pow(0, -1)} ${DetMath.pow(-0, -3)} ${DetMath.pow(-0, -2)}`);
  sys.log.info(`${DetMath.pow(1, nan)} ${DetMath.pow(-1, inf)} ${DetMath.pow(1, -inf)} ${DetMath.pow(nan, 0)} ${DetMath.log(-0)} ${1 / DetMath.sin(-0)} ${1 / DetMath.tanh(-0)} ${DetMath.exp(0)}`);
}
