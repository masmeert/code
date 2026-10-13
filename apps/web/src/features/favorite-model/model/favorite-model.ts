import { decodeChoice } from "@/entities/provider";
import { getSettings, updateHarness } from "@/entities/settings";

/** Stars or unstars a `<harness>:<model>` choice. */
export function toggleFavoriteModel(choice: string) {
  const { provider, model } = decodeChoice(choice);
  const starred = getSettings().providers[provider].favoriteModels ?? [];
  updateHarness(provider, {
    favoriteModels: starred.includes(model)
      ? starred.filter((id) => id !== model)
      : [...starred, model],
  });
}
