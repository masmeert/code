import type {
  ModelOption,
  ProviderKind,
  ProviderSettings,
  ProviderStatus,
  Settings,
} from "@masscode/contracts";

/** Models in the order the user arranged them; ones they haven't placed keep the harness's order, after the rest. */
export function orderModels(models: ReadonlyArray<ModelOption>, harness: ProviderSettings) {
  const order = harness.modelOrder ?? [];

  function getOrderIndex(id: string) {
    return order.includes(id) ? order.indexOf(id) : order.length;
  }

  return models.toSorted((left, right) => getOrderIndex(left.id) - getOrderIndex(right.id));
}

/** Models offered in pickers: arranged, without the ones switched off. */
export function getVisibleModels(models: ReadonlyArray<ModelOption>, harness: ProviderSettings) {
  return orderModels(models, harness).filter((model) => !harness.hiddenModels?.includes(model.id));
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
