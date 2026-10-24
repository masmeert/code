import type { PromptOption } from "@masscode/ui/agents/prompt-input";
import { PROVIDER_LOGO } from "../ui/provider-logo.tsx";
import { IconStar } from "@tabler/icons-react";
import { createElement } from "react";
import { getVisibleModels } from "@masscode/client";
import {
  PROVIDER_NAME,
  ProviderKind,
  type ProviderStatus,
  type Settings,
} from "@masscode/contracts";

/** The harness's name as the user set it in Settings, else its own. */
export function formatHarnessLabel(settings: Settings, provider: ProviderKind) {
  return settings.providers[provider].displayName?.trim() || PROVIDER_NAME[provider];
}

/** Star marking a harness's own default pick (model, effort) in menus. */
export function renderRecommendedBadge() {
  return createElement(IconStar, {
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
