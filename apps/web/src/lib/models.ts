import type { PromptOption } from "@masscode/ui/agents/prompt-input";
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
} from "@masscode/contracts";

/** The harness's name as the user set it in Settings, else its own. */
export function formatHarnessLabel(settings: Settings, provider: ProviderKind) {
  return settings.providers[provider].displayName?.trim() || PROVIDER_NAME[provider];
}

/** Models in the order the user arranged them; ones they haven't placed keep the harness's order, after the rest. */
export function orderModels(models: ReadonlyArray<ModelOption>, harness: ProviderSettings) {
  const order = harness.modelOrder ?? [];

  function getOrderIndex(id: string) {
    return order.includes(id) ? order.indexOf(id) : order.length;
  }

  return models.toSorted((left, right) => getOrderIndex(left.id) - getOrderIndex(right.id));
}

/** Models offered in pickers: arranged, without the ones switched off. */
function getVisibleModels(models: ReadonlyArray<ModelOption>, harness: ProviderSettings) {
  return orderModels(models, harness).filter((model) => !harness.hiddenModels?.includes(model.id));
}

/** Star marking a harness's own default pick (model, effort) in menus. */
export function renderRecommendedBadge() {
  return createElement(Star, {
    "aria-label": "Recommended",
    className: "size-3 fill-current text-brand",
  });
}

/** Composer picker values are `<harness>:<model>`. */
export function encodeChoice(provider: ProviderKind, model: string) {
  return `${provider}:${model}`;
}

export function decodeChoice(value: string) {
  const index = value.indexOf(":");
  // SAFETY: every choice is built by encodeChoice, and provider kinds hold no ":".
  return { provider: value.slice(0, index) as ProviderKind, model: value.slice(index + 1) };
}

/** Picker options for the linked harnesses (optionally just one), each under its harness. */
export function buildModelChoices(
  providers: ReadonlyArray<ProviderStatus>,
  settings: Settings,
  only?: ProviderKind,
): Array<PromptOption> {
  return providers.flatMap((provider) =>
    !provider.linked || (only && provider.kind !== only)
      ? []
      : getVisibleModels(provider.models, settings.providers[provider.kind]).map((model) => ({
          value: encodeChoice(provider.kind, model.id),
          label: model.label,
          group: formatHarnessLabel(settings, provider.kind),
          groupIcon: createElement(PROVIDER_LOGO[provider.kind]),
        })),
  );
}

/** The models the user starred, as picker values. */
export function getFavoriteChoices(settings: Settings) {
  return ProviderKind.literals.flatMap((provider) =>
    (settings.providers[provider].favoriteModels ?? []).map((model) =>
      encodeChoice(provider, model),
    ),
  );
}

/** The model a harness uses when none is picked: the Settings default if still listed, else the recommended one, else its first. */
export function findDefaultModel(
  providers: ReadonlyArray<ProviderStatus>,
  settings: Settings,
  provider: ProviderKind,
) {
  const models = getVisibleModels(
    providers.find((status) => status.kind === provider)?.models ?? [],
    settings.providers[provider],
  );
  const saved = settings.providers[provider].defaultModel;
  if (saved && (!models.length || models.some((model) => model.id === saved))) return saved;
  return (models.find((model) => model.recommended) ?? models[0])?.id ?? saved ?? null;
}

/** The picked `<harness>:<model>` as its harness lists it. */
export function findCatalogModel(
  providers: ReadonlyArray<ProviderStatus>,
  choice: string | undefined,
) {
  if (!choice) return undefined;
  const { provider, model } = decodeChoice(choice);
  return providers
    .find((status) => status.kind === provider)
    ?.models.find((option) => option.id === model);
}
