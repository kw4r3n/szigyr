// expect: ok
// stage: 1
import { parse } from "npm:yaml";

export function names(js: Js, text: string): Result<Array<string>, string> {
  const doc = js.call(parse, [js.encode<string>(text)]);
  if (doc.kind === "err") {
    return err(doc.error.message);
  }
  const out = js.decode<Array<string>>(doc.value);
  if (out.kind === "err") {
    return err(out.error.message);
  }
  return ok(out.value);
}

export function field(js: Js, obj: JsRef, key: string): Result<JsRef, JsError> {
  return js.get(obj, key);
}

export async function settle(js: Js, v: JsRef): Promise<Result<JsRef, JsError>> {
  return await js.await(v);
}

export function main(sys: System): void {
  const r = names(sys.js, "- a\n- b");
  if (r.kind === "ok") {
    sys.log.info(`count=${r.value.length}`);
  } else {
    sys.log.error(r.error);
  }
}
