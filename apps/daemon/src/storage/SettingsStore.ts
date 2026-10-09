import { DEFAULT_SETTINGS, Settings } from "@masscode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandError } from "../errors.ts";
import { DATA_DIR, openJsonFile } from "./jsonFile.ts";

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly get: Effect.Effect<Settings>;
    /** Takes effect even when it can't be saved, failing after. */
    readonly update: (settings: Settings) => Effect.Effect<void, CommandError>;
  }
>()("masscode/SettingsStore") {}

const make = Effect.gen(function* () {
  // Shelving was called settling; carry over autoSettle/autoSettleDays.
  yield* Effect.tryPromise(async () => {
    const path = join(DATA_DIR, "settings.json");
    const text = await readFile(path, "utf8");
    if (text.includes('"autoSettle'))
      await writeFile(path, text.replace(/"autoSettle(Days)?"/g, '"autoShelve$1"'));
  }).pipe(Effect.ignore);

  const file = yield* openJsonFile("settings.json", Settings, DEFAULT_SETTINGS);

  return SettingsStore.of({
    get: file.get,
    update: (settings) =>
      file
        .set(settings)
        .pipe(
          Effect.mapError(
            (error) => new CommandError({ message: `Couldn't save settings: ${error.message}` }),
          ),
        ),
  });
});

export const layer = Layer.effect(SettingsStore, make);
