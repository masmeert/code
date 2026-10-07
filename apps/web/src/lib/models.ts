import type { PromptOption } from "@apcode/ui/agents/prompt-input";
import { PROVIDER_LOGO } from "@/components/provider-logo";
import { Star } from "lucide-react";
import { createElement } from "react";
import {
  type ModelOption,
  PROVIDER_NAME,
  ProviderKind,
  type ProviderSettings,
  type ProviderStatus,
  type Settings,
} from "@apcode/contracts";

/** The harness's name as the user set it in Settings, else its own. */
export const harnessLabel = (settings: Settings, provider: ProviderKind) =>
  settings.providers[provider].displayName?.trim() || PROVIDER_NAME[provider];

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
    className: "size-3 fill-current text-brand",
  });

/** Composer picker values are `<harness>:<model>`. */
export const encodeChoice = (provider: ProviderKind, model: string) => `${provider}:${model}`;
export const decodeChoice = (value: string) => {
  const index = value.indexOf(":");
  // SAFETY: every choice is built by encodeChoice, and provider kinds hold no ":".
  return { provider: value.slice(0, index) as ProviderKind, model: value.slice(index + 1) };
};

/** Picker options for the linked harnesses (optionally just one), each under its harness. */
export const modelChoices = (
  providers: ReadonlyArray<ProviderStatus>,
  settings: Settings,
  only?: ProviderKind,
): Array<PromptOption> =>
  providers.flatMap((p) =>
    !p.linked || (only && p.kind !== only)
      ? []
      : visibleModels(p.models, settings.providers[p.kind]).map((m) => ({
          value: encodeChoice(p.kind, m.id),
          label: m.label,
          group: harnessLabel(settings, p.kind),
          groupIcon: createElement(PROVIDER_LOGO[p.kind]),
        })),
  );

/** The models the user starred, as picker values. */
export const favoriteChoices = (settings: Settings) =>
  ProviderKind.literals.flatMap((provider) =>
    (settings.providers[provider].favoriteModels ?? []).map((model) =>
      encodeChoice(provider, model),
    ),
  );

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

/** The picked `<harness>:<model>` as its harness lists it. */
export const catalogModel = (
  providers: ReadonlyArray<ProviderStatus>,
  choice: string | undefined,
) => {
  if (!choice) return undefined;
  const { provider, model } = decodeChoice(choice);
  return providers.find((p) => p.kind === provider)?.models.find((m) => m.id === model);
};
