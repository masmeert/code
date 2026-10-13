import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { existsSync, renameSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";
import { getErrorMessage } from "../errors.ts";

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

/** A TOML file couldn't be written; what's in memory has changes it doesn't. */
export class FileWriteError extends Schema.TaggedError<FileWriteError>()("FileWriteError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * `stringify`, with multi-line strings as `'''` blocks so they read as typed. A string a literal
 * block can't hold (one with `'''`, or control characters other than tab) or would end confusingly
 * (on a quote, as `''''`) stays escaped. Ends with one newline.
 */
export function formatToml(table: Parameters<typeof stringify>[0]) {
  const text = stringify(table).replace(
    /^(.+?) = ("(?:[^"\\]|\\.)*")$/gm,
    (line, key: string, quoted: string) => {
      if (!quoted.includes("\\n")) return line;

      try {
        // smol-toml escapes strings as JSON does.
        const value: string = JSON.parse(quoted);

        // oxlint-disable-next-line no-control-regex -- the characters a literal string can't hold.
        return value.includes("'''") || value.endsWith("'") || /[\0-\x08\x0b-\x1f\x7f]/.test(value)
          ? line
          : `${key} = '''\n${value}'''`;
      } catch {
        return line;
      }
    },
  );

  return `${text.trimEnd()}\n`;
}

/**
 * A schema-validated TOML file, `<name>.toml` in the data folder, held in memory and written
 * through on every change. A missing or invalid file starts from `fallback`. A list is kept
 * under a key named after the file, since TOML's top level is a table. The first open moves
 * what an older build left in `<name>.json` over, deleting it once the TOML reads back.
 */
export function openTomlFile<A, I>(name: string, schema: Schema.Codec<A, I>, fallback: A) {
  return Effect.gen(function* () {
    const path = join(DATA_DIR, `${name}.toml`);
    const legacyPath = join(DATA_DIR, `${name}.json`);
    const encode = Schema.encodeSync(schema);
    const decode = Schema.decodeUnknownEffect(schema);

    function toToml(value: A) {
      // TOML has no null, so nulls are left out; the schemas read a missing key as null again.
      const encoded: TomlTable | Array<TomlValue> = JSON.parse(
        JSON.stringify(encode(value), (_key, entry) => (entry === null ? undefined : entry)),
      );

      return formatToml(Array.isArray(encoded) ? { [name]: encoded } : encoded);
    }

    function fromToml(text: string) {
      return Effect.try(() => parse(text)).pipe(
        Effect.flatMap((table) =>
          decode(name in table && Array.isArray(table[name]) ? table[name] : table),
        ),
      );
    }

    async function write(value: A) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, toToml(value));
    }

    const readToml = Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.flatMap(fromToml));

    // The JSON is only deleted once its TOML reads back, so a failed move is retried next launch.
    const migrate = Effect.tryPromise(() => readFile(legacyPath, "utf8")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.tap((value) =>
        Effect.tryPromise(() => write(value)).pipe(
          Effect.andThen(readToml),
          Effect.andThen(Effect.tryPromise(() => rm(legacyPath))),
          Effect.catch((error) => Effect.logWarning(`Couldn't move ${legacyPath} to TOML`, error)),
        ),
      ),
    );

    const initial = yield* (existsSync(path) ? readToml : migrate).pipe(
      Effect.orElseSucceed(() => fallback),
    );

    const current = yield* Ref.make(initial);

    /** Changes the value in memory, then writes it; fails when the write does. */
    function set(value: A) {
      return Ref.set(current, value).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => write(value),
            catch: (error) => new FileWriteError({ path, message: getErrorMessage(error) }),
          }),
        ),
      );
    }

    return { get: Ref.get(current), set };
  });
}
