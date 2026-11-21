// expect-output: got hello
// expect-output: bad: $: expected string
// stage: 1
// open-question: Q128
export function main(sys: System): void {
  const js = sys.js;
  const cb = js.callback<string>((r: Result<string, CastError>): void => {
    if (r.kind === "ok") {
      sys.log.info(`got ${r.value}`);
    } else {
      sys.log.info(`bad: ${r.error.message}`);
    }
  });
  js.call(cb, [js.encode<string>("hello")]);
  js.call(cb, [js.encode<f64>(1)]);
}
