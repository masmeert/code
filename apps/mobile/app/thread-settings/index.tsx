import { getVisibleModels } from "@masscode/client";
import { ClientCommand, PROVIDER_NAME, type ProviderKind } from "@masscode/contracts";
import { Button, HStack, Image, RNHostView, Section, Spacer, Text } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- @expo/ui names it after SwiftUI.
  contentShape as hitArea,
  font,
  foregroundStyle,
  onTapGesture,
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- @expo/ui names it after SwiftUI.
  shapes as hitAreas,
} from "@expo/ui/swift-ui/modifiers";
import { router, Stack } from "expo-router";
import { useEffect, useState } from "react";
import { FormLinkRow, FormList, FormSection } from "@/components/form-list.tsx";
import { ProviderLogo } from "@/components/provider-logo.tsx";
import { send, useStore } from "@/lib/store.ts";
import { useThreadSettings } from "@/lib/thread-settings.ts";

/** Providers whose models show from the start; the rest fold so a long catalog can't bury them. */
const PRIMARY_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["claude", "codex"]);

type ProviderFilter = ProviderKind | "favorites" | null;

export default function ThreadSettingsScreen() {
  const session = useThreadSettings((state) => state.session);
  const host = useStore((state) => (session ? state.hosts[session.hostId] : undefined));
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(null);
  // The model picked here applies on Save; Cancel leaves the thread as it was.
  const [pendingModel, setPendingModel] = useState<string | null>(null);

  const [expansionOverrides, setExpansionOverrides] = useState<
    Partial<Record<ProviderKind, boolean>>
  >({});

  useEffect(() => () => useThreadSettings.setState({ session: null }), []);

  const settings = host?.settings;

  if (!session || !settings) return null;

  const shownModel = pendingModel ?? session.model;
  const isNarrowed = query.trim() !== "" || providerFilter !== null;

  const catalog = (host.providers ?? [])
    .filter((status) => status.linked)
    .filter(
      (status) =>
        providerFilter === null || providerFilter === "favorites" || providerFilter === status.kind,
    )
    .map((status) => {
      const favorites = settings.providers[status.kind].favoriteModels ?? [];

      const models = getVisibleModels(status.models, settings.providers[status.kind])
        .filter((model) => providerFilter !== "favorites" || favorites.includes(model.id))
        .filter((model) =>
          `${model.label} ${model.id} ${PROVIDER_NAME[status.kind]}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )
        // Favorites first, each group keeping the arranged order.
        .sort(
          (left, right) =>
            Number(favorites.includes(right.id)) - Number(favorites.includes(left.id)),
        );

      const isExpanded =
        isNarrowed ||
        (expansionOverrides[status.kind] ??
          (PRIMARY_PROVIDERS.has(status.kind) ||
            shownModel?.startsWith(`${status.kind}:`) === true));

      return { kind: status.kind, models, favorites, isExpanded };
    })
    .filter((group) => group.models.length > 0);

  function toggleFavorite(kind: ProviderKind, modelId: string, favorites: ReadonlyArray<string>) {
    if (!settings || !session) return;

    send(
      session.hostId,
      ClientCommand.cases["settings.update"].make({
        settings: {
          ...settings,
          providers: {
            ...settings.providers,
            [kind]: {
              ...settings.providers[kind],
              favoriteModels: favorites.includes(modelId)
                ? favorites.filter((id) => id !== modelId)
                : [...favorites, modelId],
            },
          },
        },
      }),
    );
  }

  function save() {
    if (pendingModel && pendingModel !== session?.model) session?.onModelChange?.(pendingModel);

    router.back();
  }

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          accessibilityLabel="Cancel thread settings"
          onPress={() => router.back()}
        >
          Cancel
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" onPress={save}>
          {pendingModel && pendingModel !== session.model ? "Save" : "Done"}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      {session.onModelChange ? (
        <>
          <Stack.SearchBar
            placeholder="Find a model"
            autoCapitalize="none"
            onChangeText={(event) => setQuery(event.nativeEvent.text)}
            onCancelButtonPress={() => setQuery("")}
          />
          <Stack.Toolbar>
            <Stack.Toolbar.Menu
              icon={
                providerFilter === null
                  ? "line.3.horizontal.decrease.circle"
                  : "line.3.horizontal.decrease.circle.fill"
              }
              accessibilityLabel="Filter models"
              separateBackground
              title="Model filters"
            >
              <Stack.Toolbar.Menu title="Provider">
                <Stack.Toolbar.MenuAction
                  isOn={providerFilter === null}
                  onPress={() => setProviderFilter(null)}
                >
                  All providers
                </Stack.Toolbar.MenuAction>
                <Stack.Toolbar.MenuAction
                  isOn={providerFilter === "favorites"}
                  onPress={() => setProviderFilter("favorites")}
                >
                  Favorites
                </Stack.Toolbar.MenuAction>
                {host.providers
                  .filter((status) => status.linked)
                  .map((status) => (
                    <Stack.Toolbar.MenuAction
                      key={status.kind}
                      isOn={providerFilter === status.kind}
                      onPress={() => setProviderFilter(status.kind)}
                    >
                      {PROVIDER_NAME[status.kind]}
                    </Stack.Toolbar.MenuAction>
                  ))}
              </Stack.Toolbar.Menu>
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.SearchBarSlot />
          </Stack.Toolbar>
        </>
      ) : null}
      <FormList>
        {session.onModelChange
          ? catalog.map((group) => (
              <Section
                key={group.kind}
                header={
                  <Button
                    onPress={() =>
                      setExpansionOverrides((current) => ({
                        ...current,
                        [group.kind]: !group.isExpanded,
                      }))
                    }
                    modifiers={[buttonStyle("plain"), hitArea(hitAreas.rectangle())]}
                  >
                    <HStack spacing={8}>
                      <RNHostView matchContents>
                        <ProviderLogo
                          provider={group.kind}
                          className="size-[15px] text-muted-foreground"
                        />
                      </RNHostView>
                      <Text>{PROVIDER_NAME[group.kind]}</Text>
                      <Spacer />
                      {group.isExpanded ? null : <Text>{String(group.models.length)}</Text>}
                      {isNarrowed ? null : (
                        <Image
                          systemName={group.isExpanded ? "chevron.up" : "chevron.down"}
                          modifiers={[font({ size: 12, weight: "semibold" })]}
                        />
                      )}
                    </HStack>
                  </Button>
                }
              >
                {group.isExpanded
                  ? group.models.map((model) => {
                      const value = `${group.kind}:${model.id}`;
                      const isFavorite = group.favorites.includes(model.id);

                      return (
                        <HStack
                          key={value}
                          spacing={12}
                          modifiers={[
                            hitArea(hitAreas.rectangle()),
                            onTapGesture(() => setPendingModel(value)),
                          ]}
                        >
                          <Text>{model.label}</Text>
                          <Spacer />
                          <Button
                            onPress={() => toggleFavorite(group.kind, model.id, group.favorites)}
                            modifiers={[buttonStyle("borderless")]}
                          >
                            <Image
                              systemName={isFavorite ? "star.fill" : "star"}
                              modifiers={[foregroundStyle(isFavorite ? "orange" : "gray")]}
                            />
                          </Button>
                          {value === shownModel ? (
                            <Image
                              systemName="checkmark"
                              modifiers={[font({ weight: "semibold" })]}
                            />
                          ) : null}
                        </HStack>
                      );
                    })
                  : null}
              </Section>
            ))
          : null}
        <FormSection
          title="Options"
          footer={
            session.onModelChange
              ? undefined
              : "The model can change once the agent finishes this turn."
          }
        >
          {session.options.map((group) => (
            <FormLinkRow
              key={group.title}
              label={group.title}
              value={group.options.find((option) => option.value === group.value)?.label}
              onPress={() =>
                router.push({ pathname: "/thread-settings/choice", params: { title: group.title } })
              }
            />
          ))}
        </FormSection>
      </FormList>
    </>
  );
}
