type Palette = Record<string, string | number[]>;
const pal = {
  red: [255, 0, 0],
  green: "#00ff00",
} satisfies Palette;
function main(): void {
  console.log(pal.red.length, pal.green.toUpperCase());
}
main();
