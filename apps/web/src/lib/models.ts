import type { PromptModel } from "@apcode/ui/agents/prompt-input";
import { PROVIDER_LOGO } from "@/components/provider-logo";
import { Star } from "lucide-react";
import { createElement } from "react";
import type {
  ModelOption,
  ProviderKind,
  ProviderSettings,
  ProviderStatus,
  Settings,
} from "@apcode/contracts";

export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** The harness's name as the user set it in Settings, else its own. */
export const harnessLabel = (settings: Settings, provider: ProviderKind) =>
  settings.providers[provider].displayName?.trim() || PROVIDER_LABEL[provider];

/** Models in the order the user arranged them; ones they haven't placed keep the harness's order, after the rest. */
export const orderedModels = (models: ReadonlyArray<ModelOption>, harness: ProviderSettings) => {
  const order = harness.modelOrder ?? [];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return models.toSorted((a, b) => rank(a.id) - rank(b.id));
};

/** Models offered in pickers: arranged, without the ones switched off. */
export const visibleModels = (models: ReadonlyArray<ModelOption>, harness: ProviderSettings) =>
  orderedModels(models, harness).filter((m) => !harness.hiddenModels?.includes(m.id));

/** Star marking a harness's own default pick (model, effort) in menus. */
export const recommendedBadge = () =>
  createElement(Star, {
    "aria-label": "Recommended",
    className: "size-3 fill-current text-amber-500",
  });

/** Composer picker values are `<harness>:<model>`. */
export const encodeChoice = (provider: ProviderKind, model: string) => `${provider}:${model}`;
export const decodeChoice = (value: string) => {
  const index = value.indexOf(":");
  // SAFETY: every choice is built by encodeChoice, and provider kinds hold no ":".
  return { provider: value.slice(0, index) as ProviderKind, model: value.slice(index + 1) };
};

/** Picker options for the linked harnesses (optionally just one): every favorite in one list, then each harness's other models, folded. */
export const modelChoices = (
  providers: ReadonlyArray<ProviderStatus>,
  settings: Settings,
  only?: ProviderKind,
): Array<PromptModel> => {
  const favorites: Array<PromptModel> = [];
  const rest: Array<PromptModel> = [];
  for (const p of providers) {
    if (!p.linked || (only && p.kind !== only)) continue;
    const harness = settings.providers[p.kind];
    for (const m of visibleModels(p.models, harness)) {
      const logo = createElement(PROVIDER_LOGO[p.kind]);
      const option = {
        value: encodeChoice(p.kind, m.id),
        label: m.label,
      };
      // Favorites keep their harness logo on the row, so the trigger still shows whose model it is.
      if (harness.favoriteModels?.includes(m.id))
        favorites.push({ ...option, icon: logo, group: "Favorites" });
      else
        rest.push({
          ...option,
          group: harnessLabel(settings, p.kind),
          groupIcon: logo,
          foldable: true,
        });
    }
  }
  return [...favorites, ...rest];
};

/** The model a harness uses when none is picked: the Settings default if still listed, else the recommended one, else its first. */
export const defaultModel = (
  providers: ReadonlyArray<ProviderStatus>,
  settings: Settings,
  provider: ProviderKind,
) => {
  const models = visibleModels(
    providers.find((p) => p.kind === provider)?.models ?? [],
    settings.providers[provider],
  );
  const saved = settings.providers[provider].defaultModel;
  if (saved && (!models.length || models.some((m) => m.id === saved))) return saved;
  return (models.find((m) => m.recommended) ?? models[0])?.id ?? saved ?? null;
};

/** Effort the harness applies to the picked `<harness>:<model>` when none is chosen. */
export const defaultEffort = (
  providers: ReadonlyArray<ProviderStatus>,
  choice: string | undefined,
) => {
  if (!choice) return undefined;
  const { provider, model } = decodeChoice(choice);
  return providers.find((p) => p.kind === provider)?.models.find((m) => m.id === model)
    ?.defaultEffort;
};
