import type { PromptModel } from "@/components/agents/prompt-input";
import { PROVIDER_LOGO } from "@/components/provider-logo";
import { Star } from "lucide-react";
import { createElement } from "react";
import type { ProviderKind, ProviderStatus, Settings } from "@apcode/contracts";

export const PROVIDER_LABEL: Record<ProviderKind, string> = { claude: "Claude Code", codex: "Codex" };

/** Star marking a harness's own default pick (model, effort) in menus. */
export const recommendedBadge = () =>
  createElement(Star, { "aria-label": "Recommended", className: "size-3 fill-current text-amber-500" });

/** Composer picker values are `<harness>:<model>`. */
export const encodeChoice = (provider: ProviderKind, model: string) => `${provider}:${model}`;
export const decodeChoice = (value: string) => {
  const index = value.indexOf(":");
  return { provider: value.slice(0, index) as ProviderKind, model: value.slice(index + 1) };
};

/** Picker options for the linked harnesses (optionally just one). */
export const modelChoices = (providers: ReadonlyArray<ProviderStatus>, only?: ProviderKind): Array<PromptModel> =>
  providers
    .filter((p) => p.linked && (!only || p.kind === only))
    .flatMap((p) =>
      p.models.map((m) => ({
        value: encodeChoice(p.kind, m.id),
        label: m.label,
        badge: m.recommended ? recommendedBadge() : undefined,
        group: PROVIDER_LABEL[p.kind],
        groupIcon: createElement(PROVIDER_LOGO[p.kind]),
      })),
    );

/** The model a harness uses when none is picked: the Settings default if still listed, else the recommended one, else its first. */
export const defaultModel = (providers: ReadonlyArray<ProviderStatus>, settings: Settings, provider: ProviderKind) => {
  const models = providers.find((p) => p.kind === provider)?.models ?? [];
  const saved = settings.providers[provider].defaultModel;
  if (saved && (!models.length || models.some((m) => m.id === saved))) return saved;
  return (models.find((m) => m.recommended) ?? models[0])?.id ?? saved ?? null;
};

/** Effort the harness applies to the picked `<harness>:<model>` when none is chosen. */
export const defaultEffort = (providers: ReadonlyArray<ProviderStatus>, choice: string | undefined) => {
  if (!choice) return undefined;
  const { provider, model } = decodeChoice(choice);
  return providers.find((p) => p.kind === provider)?.models.find((m) => m.id === model)?.defaultEffort;
};
