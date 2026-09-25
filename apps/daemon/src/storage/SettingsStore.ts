import { DEFAULT_SETTINGS, Settings } from "@apcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { openJsonFile } from "./jsonFile.ts";

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly get: Effect.Effect<Settings>;
    readonly update: (settings: Settings) => Effect.Effect<Settings>;
  }
>()("apcode/SettingsStore") {}

const make = Effect.gen(function* () {
  const file = yield* openJsonFile("settings.json", Settings, DEFAULT_SETTINGS);
  return SettingsStore.of({
    get: file.get,
    update: (settings) => file.set(settings).pipe(Effect.as(settings)),
  });
});

export const layer = Layer.effect(SettingsStore, make);
