// expect: ok
// stage: 1
// open-question: Q128
type Event = { readonly name: string; readonly count: u32 };

export function listener(js: Js, log: Log): JsRef {
  return js.callback((r: Result<Event, CastError>): void => {
    if (r.kind === "ok") {
      log.info(r.value.name);
    }
  });
}
