import {
  categoryOf,
  describeActivity,
  formatAge,
  formatProjectLabel,
  getStatusDotStyle,
  NEEDS_YOU,
  PLAN_APPROVAL_TITLE,
  useNow,
} from "@masscode/client";
import { ClientCommand, type ThreadInfo } from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, View } from "react-native";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { OrbFace } from "@/components/OrbFace.tsx";
import { ProviderLogo } from "@/components/ProviderLogo.tsx";
import { Pulsing } from "@/components/Pulsing.tsx";
import { NativeButton } from "@/components/ui/native-button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/cn.ts";
import { type HostState, reconnectAll, send, useStore } from "@/lib/store.ts";

interface ThreadRow {
  readonly hostId: string;
  /** Shown when there's more than one host to tell apart. */
  readonly hostName: string | null;
  readonly projectName: string;
  readonly thread: ThreadInfo;
}

interface ArchivedThread {
  readonly hostId: string;
  readonly threadId: string;
  readonly title: string;
}

function archive(hostId: string, threadId: string, archived: boolean) {
  send(hostId, ClientCommand.cases["thread.archive"].make({ threadId, archived }));
}

export default function ThreadsScreen() {
  const isLoaded = useStore((state) => state.isLoaded);
  const hosts = useStore((state) => state.hosts);
  const [archived, setArchived] = useState<ArchivedThread | null>(null);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [hostFilter, setHostFilter] = useState<string | null>(null);

  useEffect(() => {
    if (!archived) return;

    const timer = setTimeout(() => setArchived(null), 5000);

    return () => clearTimeout(timer);
  }, [archived]);

  const hasManyHosts = Object.keys(hosts).length > 1;

  const allRows = useMemo(
    () =>
      Object.entries(hosts)
        .flatMap(([hostId, host]) =>
          Object.values(host.threads)
            // Shelved threads stay on the desktop's sidebar; here they only come back when they need you.
            .filter(
              (thread) =>
                thread.archivedAt === null && (!thread.shelved || NEEDS_YOU[thread.status]),
            )
            .map((thread): ThreadRow => ({
              hostId,
              hostName: hasManyHosts ? host.paired.name : null,
              projectName:
                host.projects.find((project) => project.id === thread.projectId)?.name ?? "",
              thread,
            })),
        )
        .sort((left, right) => right.thread.updatedAt - left.thread.updatedAt),
    [hosts, hasManyHosts],
  );

  const projectNames = [...new Set(allRows.map((row) => row.projectName).filter(Boolean))].sort();

  const sections = useMemo(() => {
    const words = query.trim().toLowerCase();

    const rows = allRows.filter(
      (row) =>
        (hostFilter === null || row.hostId === hostFilter) &&
        (projectFilter === null || row.projectName === projectFilter) &&
        (!words ||
          [row.thread.title, row.projectName, row.thread.branch ?? ""].some((field) =>
            field.toLowerCase().includes(words),
          )),
    );

    const needsYou = rows.filter((row) => NEEDS_YOU[row.thread.status]);

    return [
      { key: "needs-you", data: needsYou },
      { key: "active", data: rows.filter((row) => !NEEDS_YOU[row.thread.status]) },
    ].filter((section) => section.data.length > 0);
  }, [allRows, query, hostFilter, projectFilter]);

  const isFiltered = hostFilter !== null || projectFilter !== null;

  const unreachable = Object.values(hosts).filter(
    (host) =>
      host.connection !== "connected" &&
      host.connection !== "connecting" &&
      host.connection !== "off",
  );

  const orbState = Object.values(hosts).some((host) =>
    Object.values(host.threads).some((thread) => thread.status === "running"),
  )
    ? "thinking"
    : "idle";

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          // Unpaired, the pairing prompt centers on the whole screen rather than below the header.
          headerTransparent: isLoaded && Object.keys(hosts).length === 0,
          // The orb sits in a left toolbar item, as a title would sit centered there.
          headerTitle: "",
        }}
      />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          <OrbFace size={36} state={orbState} />
        </Stack.Toolbar.View>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="gearshape"
          accessibilityLabel="Settings"
          onPress={() => router.push("/settings")}
        />
      </Stack.Toolbar>
      {Object.keys(hosts).length > 0 ? (
        <>
          <Stack.SearchBar
            placeholder="Search threads"
            onChangeText={(event) => setQuery(event.nativeEvent.text)}
            onCancelButtonPress={() => setQuery("")}
          />
          <Stack.Toolbar>
            <Stack.Toolbar.Menu
              icon={
                isFiltered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease"
              }
              accessibilityLabel="Filter threads"
              separateBackground
              title="Show threads from"
            >
              {hasManyHosts ? (
                <Stack.Toolbar.Menu title="Computer" icon="laptopcomputer">
                  <Stack.Toolbar.MenuAction
                    isOn={hostFilter === null}
                    onPress={() => setHostFilter(null)}
                  >
                    All computers
                  </Stack.Toolbar.MenuAction>
                  {Object.values(hosts).map((host) => (
                    <Stack.Toolbar.MenuAction
                      key={host.paired.id}
                      isOn={hostFilter === host.paired.id}
                      onPress={() => setHostFilter(host.paired.id)}
                    >
                      {host.paired.name}
                    </Stack.Toolbar.MenuAction>
                  ))}
                </Stack.Toolbar.Menu>
              ) : null}
              <Stack.Toolbar.Menu title="Project" icon="folder">
                <Stack.Toolbar.MenuAction
                  isOn={projectFilter === null}
                  onPress={() => setProjectFilter(null)}
                >
                  All projects
                </Stack.Toolbar.MenuAction>
                {projectNames.map((name) => (
                  <Stack.Toolbar.MenuAction
                    key={name}
                    isOn={projectFilter === name}
                    onPress={() => setProjectFilter(name)}
                  >
                    {name}
                  </Stack.Toolbar.MenuAction>
                ))}
              </Stack.Toolbar.Menu>
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.SearchBarSlot />
            <Stack.Toolbar.Spacer width={0} />
            <Stack.Toolbar.Button
              icon="square.and.pencil"
              accessibilityLabel="New thread"
              separateBackground
              onPress={() => router.push("/new")}
            />
          </Stack.Toolbar>
        </>
      ) : null}
      {isLoaded && Object.keys(hosts).length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Text className="text-center text-xl font-semibold">Your threads, on the go</Text>
          <Text className="text-center text-sm leading-6 text-muted-foreground">
            Pair this phone with MassCode on your computer to follow your threads, answer the agent
            and steer it from anywhere on your Tailscale network.
          </Text>
          <NativeButton
            label="Pair with your computer"
            className="mt-3"
            onPress={() => router.push("/pair")}
          />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(row) => `${row.hostId}/${row.thread.id}`}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="pb-24"
          stickySectionHeadersEnabled={false}
          refreshControl={<RefreshControl refreshing={false} onRefresh={reconnectAll} />}
          ListHeaderComponent={
            unreachable.length > 0 ? <UnreachableHosts hosts={unreachable} /> : undefined
          }
          ListEmptyComponent={
            isLoaded ? (
              <Text className="p-8 text-center text-sm text-muted-foreground">
                {query.trim() || isFiltered
                  ? "No threads match. Clear the search or the filter to see them all."
                  : "No threads yet. Start one with the compose button."}
              </Text>
            ) : undefined
          }
          renderSectionHeader={({ section }) =>
            section.key === "needs-you" ? (
              <View className="flex-row items-center gap-2 px-5 pt-3 pb-1">
                <View className="size-1.5 rounded-full bg-warning" />
                <Text className="text-xs font-medium">Needs you</Text>
                <Text className="text-xs font-medium text-muted-foreground tabular-nums">
                  {section.data.length}
                </Text>
              </View>
            ) : (
              <Text className="px-5 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                Active
              </Text>
            )
          }
          renderItem={({ item }) => (
            <ThreadRowView
              row={item}
              onArchive={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                archive(item.hostId, item.thread.id, true);
                setArchived({
                  hostId: item.hostId,
                  threadId: item.thread.id,
                  title: item.thread.title || "New thread",
                });
              }}
            />
          )}
        />
      )}
      {archived ? (
        <View className="bottom-safe-offset-16 absolute inset-x-4 flex-row items-center gap-3 rounded-2xl border border-border bg-popover py-2 pr-2 pl-4">
          <Text numberOfLines={1} className="flex-1 text-sm">
            Archived <Text className="text-sm text-muted-foreground">{archived.title}</Text>
          </Text>
          <NativeButton
            label="Undo"
            variant="outlined"
            size="small"
            onPress={() => {
              archive(archived.hostId, archived.threadId, false);
              setArchived(null);
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

function UnreachableHosts({ hosts }: { hosts: ReadonlyArray<HostState> }) {
  return (
    <Pressable
      onPress={() => router.push("/settings/computers")}
      className="mx-4 mt-2 mb-1 gap-0.5 rounded-2xl border border-border bg-card px-4 py-3 active:bg-muted"
    >
      <Text className="text-sm font-medium">
        {hosts.length === 1
          ? `Can't reach ${hosts[0]?.paired.name}`
          : `Can't reach ${hosts.length} computers`}
      </Text>
      <Text className="text-xs leading-5 text-muted-foreground">
        {hosts.some((host) => host.connection === "unpaired" || host.connection === "outdated")
          ? "Tap to see why."
          : "Retrying. Check the computer is awake with MassCode open, and Tailscale is on."}
      </Text>
    </Pressable>
  );
}

function ThreadRowView({ row, onArchive }: { row: ThreadRow; onArchive: () => void }) {
  const { thread } = row;
  const needsYou = NEEDS_YOU[thread.status];
  const isUnread = thread.seenRev < thread.updatedAt;
  const request = needsYou ? thread.request : null;
  const isRunning = thread.status === "running";
  const now = useNow();
  const [isResponding, setIsResponding] = useState(false);

  function respond(decision: "allow" | "deny") {
    if (!request) return;

    setIsResponding(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    send(
      row.hostId,
      ClientCommand.cases["approval.respond"].make({
        threadId: thread.id,
        requestId: request.requestId,
        decision,
      }),
    );
  }

  function open() {
    router.push(`/thread/${row.hostId}/${thread.id}`);
  }

  return (
    <Swipeable
      friction={2}
      rightThreshold={40}
      renderRightActions={() => (
        <Pressable
          accessibilityLabel={`Archive ${thread.title}`}
          onPress={onArchive}
          className="w-24 items-center justify-center gap-1 bg-muted"
        >
          <Icon name="archivebox" className="size-4 text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">Archive</Text>
        </Pressable>
      )}
    >
      <Pressable onPress={open} className="bg-background px-5 py-3 active:bg-card">
        <Text
          numberOfLines={1}
          className={cn("text-[15px]", isUnread || needsYou ? "font-semibold" : "font-medium")}
        >
          {thread.title || "New thread"}
        </Text>
        <View className="mt-1 h-5 flex-row items-center gap-2">
          <Pulsing isLive={isRunning}>
            <View
              role="img"
              aria-label={getStatusDotStyle(thread, isUnread, false).label}
              className={cn("size-2 rounded-full", getStatusDotStyle(thread, isUnread, false).tone)}
            />
          </Pulsing>
          <ProviderLogo
            provider={thread.provider}
            className={cn(
              "size-3.5 text-muted-foreground",
              isRunning && thread.provider === "claude" && "text-[#D97757]",
            )}
          />
          {isRunning ? (
            <Pulsing className="flex-1">
              <Text
                numberOfLines={1}
                className={cn(
                  "text-[13px] text-muted-foreground",
                  thread.activity &&
                    categoryOf(thread.activity.tool) === "run" &&
                    "font-mono text-xs",
                )}
              >
                {describeActivity(thread.activity)}
              </Text>
            </Pulsing>
          ) : (
            <View className="flex-1 flex-row items-center gap-2">
              <Text numberOfLines={1} className="shrink text-[13px] text-muted-foreground">
                {formatProjectLabel(row.projectName, row.hostName)}
              </Text>
              {thread.branch ? (
                <>
                  <View className="h-3 w-px bg-border-strong" />
                  <Text numberOfLines={1} className="shrink text-[13px] text-muted-foreground/70">
                    {thread.branch}
                  </Text>
                </>
              ) : null}
            </View>
          )}
          {needsYou ? (
            <Text className={cn("text-[13px] font-medium", needsYou.labelTone)}>
              {needsYou.label}
            </Text>
          ) : (
            <Text className="text-[13px] text-muted-foreground tabular-nums">
              {formatAge(thread.updatedAt, now)}
            </Text>
          )}
        </View>
        {request && !request.asksQuestions && request.title !== PLAN_APPROVAL_TITLE ? (
          <>
            <Text
              numberOfLines={2}
              className="mt-2 rounded-lg bg-muted/70 px-2 py-1 font-mono text-[11px] text-muted-foreground"
            >
              <Text className="font-mono text-[11px]">{request.title}</Text> {request.detail}
            </Text>
            <View className="mt-2 flex-row gap-1.5">
              <NativeButton
                label="Allow"
                size="small"
                isDisabled={isResponding}
                onPress={() => respond("allow")}
              />
              <NativeButton
                label="Deny"
                variant="text"
                size="small"
                isDisabled={isResponding}
                onPress={() => respond("deny")}
              />
            </View>
          </>
        ) : request ? (
          <NativeButton
            label={request.asksQuestions ? "Answer" : "Review plan"}
            variant="outlined"
            size="small"
            className="mt-2 self-start"
            onPress={open}
          />
        ) : null}
      </Pressable>
    </Swipeable>
  );
}
