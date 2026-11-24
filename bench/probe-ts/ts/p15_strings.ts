function main(): void {
  const s = "hello,world,foo";
  console.log(s.split(",").join("|"));
  console.log(s.indexOf("world"), s.indexOf("zzz"));
  console.log(s.slice(2, 5), s.slice(-3));
  console.log("7".padStart(3, "0"));
  console.log(s.charCodeAt(0));
  console.log(s.toUpperCase(), s.length, s.startsWith("he"), s.includes("o,w"));
}
main();
