function main(): void {
  let found = "";
  outer: for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (i * j === 6) { found = `${i},${j}`; break outer; }
      if (j > i) continue outer;
    }
  }
  console.log(found);
}
main();
