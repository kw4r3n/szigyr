function main(): void {
  const xs = [5, 3, 8, 1];
  console.log(xs.map((x) => x * 2).join(","));
  console.log(xs.filter((x) => x > 2).length);
  console.log(xs.reduce((a, b) => a + b, 0));
  console.log(xs.find((x) => x > 5));
  console.log(xs.indexOf(8), xs.indexOf(99), xs.includes(3));
  console.log([...xs].sort((a, b) => a - b).join(","));
  console.log(xs.slice(1, 3).join(","));
}
main();
