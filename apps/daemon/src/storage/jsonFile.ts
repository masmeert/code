import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { existsSync, renameSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DATA_DIR = process.env.MASSCODE_DATA_DIR ?? join(homedir(), ".masscode");

// The app was called APCode; carry its state over once so threads and settings survive the rename.
const LEGACY_DATA_DIR = join(homedir(), ".apcode");
if (!process.env.MASSCODE_DATA_DIR && !existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
  renameSync(LEGACY_DATA_DIR, DATA_DIR);
  for (const suffix of ["", "-wal", "-shm"]) {
    const legacyDatabase = join(DATA_DIR, `apcode.db${suffix}`);
    if (existsSync(legacyDatabase))
      renameSync(legacyDatabase, join(DATA_DIR, `masscode.db${suffix}`));
  }
}

/**
 * A schema-validated JSON file held in memory and written through on every change.
 * A missing or invalid file starts from `fallback`.
 */
export function openJsonFile<A, I>(fileName: string, schema: Schema.Codec<A, I>, fallback: A) {
  return Effect.gen(function* () {
    const path = join(DATA_DIR, fileName);
    const initial = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.orElseSucceed(() => fallback),
    );
    const current = yield* Ref.make(initial);
    const encode = Schema.encodeSync(schema);

    function set(value: A) {
      return Ref.set(current, value).pipe(
        Effect.andThen(
          Effect.tryPromise(async () => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, `${JSON.stringify(encode(value), null, 2)}\n`);
          }),
        ),
        Effect.catch((error) => Effect.logWarning(`failed to write ${path}`, error)),
      );
    }

    return { get: Ref.get(current), set };
  });
}
