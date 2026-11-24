class ParseError extends Error {
  constructor(message: string, public pos: number) { super(message); this.name = "ParseError"; }
}
function parse(s: string): number {
  if (s.length === 0) throw new ParseError("empty", 0);
  return s.length;
}
function main(): void {
  for (const s of ["abc", ""]) {
    try {
      console.log(parse(s));
    } catch (e) {
      if (e instanceof ParseError) console.log("caught", e.message, e.pos);
      else throw e;
    } finally {
      console.log("done");
    }
  }
}
main();
