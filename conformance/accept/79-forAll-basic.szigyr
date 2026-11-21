// expect: ok
// stage: 4
function addOne(x: i32): i32 {
  return wrapAdd(x, 1);
}

function strictDouble(x: i32): i32 {
  "use owned";
  requires(x >= -1000 && x <= 1000);
  return x * 2;
}

function rtCheck(x: i32): boolean {
  "use rt";
  return x > 0;
}

test("forAll accept forms", (t: Test) => {
  forAll((x: i32) => x === x);
  forAll((x: i32): boolean => {
    requires(x > 0);
    return addOne(x) > 1;
  });
  forAll(function(x: i32, y: i32): void {
    requires(x >= 0 && y >= 0);
    t.ok(x >= 0 && y >= 0);
  });
  forAll(addOne);
  forAll(strictDouble);
  forAll(rtCheck);
  if (true) {
    forAll((b: boolean) => b || !b);
  }
});
