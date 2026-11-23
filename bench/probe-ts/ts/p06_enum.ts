enum Color { Red, Green, Blue }
enum Level { Low = 10, Mid = 20, High = 30 }
function colorName(c: Color): string {
  if (c === Color.Red) return "red";
  if (c === Color.Green) return "green";
  return "blue";
}
function main(): void {
  console.log(colorName(Color.Green), Color.Blue, Level.Mid + 1);
  const l: Level = Level.High;
  console.log(l);
}
main();
