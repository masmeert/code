import * as Schema from "effect/Schema";

/** What's stored under `key`, or `fallback` when nothing is, storage is off, or it isn't a `schema` any more. */
export function readStored<S extends Schema.Codec<unknown, unknown>>(
  key: string,
  schema: S,
  fallback: S["Type"],
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(localStorage.getItem(key));
  } catch {
    return fallback;
  }
}

/** Kept for the next launch, best effort: storage can be full or turned off. */
export function writeStored<S extends Schema.Codec<unknown, unknown>>(
  key: string,
  schema: S,
  value: S["Type"],
) {
  try {
    localStorage.setItem(key, Schema.encodeSync(Schema.fromJsonString(schema))(value));
  } catch {}
}
