function firstWord(s: string | undefined): string {
  if (s === undefined) return "none";
  const parts = s.split(" ");
  const w = parts[0];
  if (w === undefined) return "empty";
  return w;
}
function main(): void {
  console.log(firstWord(undefined));
  console.log(firstWord("hello world"));
  console.log(firstWord(""));
}
main();
