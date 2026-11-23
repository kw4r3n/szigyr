function main(): void {
  console.log(7 / 2, Math.floor(7 / 2), Math.trunc(-7 / 2));
  console.log(7 % 3, -7 % 3);
  console.log(2 ** 10, 0.1 + 0.2);
  console.log(Math.max(1, 5, 3), Math.min(4, 2), Math.abs(-3), Math.round(2.5), Math.sqrt(16));
  console.log(Number.parseInt("42", 10), Number.parseInt("12abc", 10), Number.isNaN(Number.parseInt("x", 10)));
  console.log((255).toString(16), (3.14159).toFixed(2));
  console.log(5 / 0, Number.MAX_SAFE_INTEGER);
}
main();
