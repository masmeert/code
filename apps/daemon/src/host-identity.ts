import { decodeBase64Url, encodeBase64Url, generateHostSecret } from "@masscode/secure-channel";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { DATA_DIR, formatToml } from "./storage/toml-file.ts";

const PATH = join(DATA_DIR, "identity.toml");

const decodeStored = Schema.decodeUnknownOption(Schema.Struct({ secret: Schema.String }));

/**
 * This daemon's long-term secret: what proves it to the relay and to phones, which pinned its
 * public half when they paired. Made on first run and kept readable by this user only; losing it
 * means pairing every phone again.
 */
export const loadHostSecret = Effect.promise(async () => {
  const stored = await readFile(PATH, "utf8")
    .then((text) => Option.getOrNull(decodeStored(parse(text))))
    .catch(() => null);

  const secret = stored && decodeBase64Url(stored.secret);

  if (secret?.length === 32) return secret;

  const created = generateHostSecret();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(PATH, formatToml({ secret: encodeBase64Url(created) }), { mode: 0o600 });
  // `mode` only applies when the file is created; a corrupt one left behind keeps its own.
  await chmod(PATH, 0o600);

  return created;
});
