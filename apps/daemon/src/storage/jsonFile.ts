import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DATA_DIR = process.env.APCODE_DATA_DIR ?? join(homedir(), ".apcode");

/**
 * A schema-validated JSON file held in memory and written through on every change.
 * A missing or invalid file starts from `fallback`.
 */
export const makeJsonFile = <A, I>(fileName: string, schema: Schema.Codec<A, I>, fallback: A) =>
  Effect.gen(function* () {
    const path = join(DATA_DIR, fileName);
    const initial = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.orElseSucceed(() => fallback),
    );
    const ref = yield* Ref.make(initial);
    const encode = Schema.encodeSync(schema);

    const set = (value: A) =>
      Ref.set(ref, value).pipe(
        Effect.andThen(
          Effect.tryPromise(async () => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, `${JSON.stringify(encode(value), null, 2)}\n`);
          }),
        ),
        Effect.catch((error) => Effect.logWarning(`failed to write ${path}`, error)),
      );

    return { get: Ref.get(ref), set };
  });
