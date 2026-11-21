// expect: E4002 @ 8:10
// stage: 2
function sid<T>(x: T): T {
  "use owned";
  return x;
}
function m<T>(x: T): T {
  return sid(x);
}
function g(): string {
  return m<string>("a");
}
