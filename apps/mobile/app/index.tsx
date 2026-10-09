import { describeActivity, formatAge, useNow } from "@masscode/client";
import { ClientCommand, type ThreadInfo } from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { Button } from "heroui-native";
import { Laptop } from "lucide-react-native";
import { useMemo } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { type MacState, reconnectAll, send, useStore } from "../src/lib/store.ts";

interface ThreadRow {
  readonly macId: string;
  readonly macName: string;
  readonly projectName: string;
  readonly thread: ThreadInfo;
}

/** Why a thread is stopped on you, as its dot and label say it. */
const NEEDS_YOU: Partial<
  Record<ThreadInfo["status"], { label: string; dotTone: string; labelTone: string }>
> = {
  "awaiting-approval": {
    label: "Needs approval",
    dotTone: "bg-warning",
    labelTone: "text-warning",
  },
  "awaiting-answer": { label: "Needs an answer", dotTone: "bg-warning", labelTone: "text-warning" },
  error: { label: "Error", dotTone: "bg-danger", labelTone: "text-danger" },
};

/** Working is mint, unread is peach, as on the desktop's sidebar. */
function findDotTone(thread: ThreadInfo, isUnread: boolean) {
  const needsYou = NEEDS_YOU[thread.status];

  if (needsYou) return needsYou.dotTone;

  if (thread.status === "running") return "bg-success";

  return isUnread ? "bg-accent" : "";
}

export default function ThreadsScreen() {
  const isLoaded = useStore((state) => state.isLoaded);
  const macs = useStore((state) => state.macs);
  const foreground = useCSSVariable("--color-foreground");

  const rows = useMemo(
    () =>
      Object.entries(macs)
        .flatMap(([macId, mac]) =>
          Object.values(mac.threads)
            // Shelved threads stay on the Mac's sidebar; here they only come back when they need you.
            .filter(
              (thread) =>
                thread.archivedAt === null && (!thread.shelved || NEEDS_YOU[thread.status]),
            )
            .map((thread): ThreadRow => ({
              macId,
              macName: mac.mac.name,
              projectName:
                mac.projects.find((project) => project.id === thread.projectId)?.name ?? "",
              thread,
            })),
        )
        .sort((left, right) => right.thread.updatedAt - left.thread.updatedAt),
    [macs],
  );

  const hasManyMacs = Object.keys(macs).length > 1;

  const unreachable = Object.values(macs).filter(
    (mac) => mac.connection !== "connected" && mac.connection !== "connecting",
  );

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable accessibilityLabel="Macs" hitSlop={12} onPress={() => router.push("/macs")}>
              <Laptop size={22} color={String(foreground ?? "#888")} />
            </Pressable>
          ),
        }}
      />
      {isLoaded && Object.keys(macs).length === 0 ? (
        <View className="flex-1 justify-center gap-4 p-8">
          <Text className="text-2xl font-semibold text-foreground">Your threads, on the go</Text>
          <Text className="text-[15px] leading-6 text-muted">
            Pair this phone with MassCode on your Mac to follow your threads, answer the agent and
            steer it from anywhere on your Tailscale network.
          </Text>
          <Button onPress={() => router.push("/pair")}>Pair with your Mac</Button>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => `${row.macId}/${row.thread.id}`}
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={<RefreshControl refreshing={false} onRefresh={reconnectAll} />}
          ListHeaderComponent={
            unreachable.length > 0 ? <UnreachableMacs macs={unreachable} /> : undefined
          }
          ListEmptyComponent={
            isLoaded ? (
              <Text className="p-8 text-center text-[15px] text-muted">
                No threads yet. Start one on your Mac, and it shows up here.
              </Text>
            ) : undefined
          }
          renderItem={({ item }) => <ThreadRowView row={item} showMac={hasManyMacs} />}
          ItemSeparatorComponent={() => <View className="bg-separator ml-9 h-px" />}
        />
      )}
    </View>
  );
}

function UnreachableMacs({ macs }: { macs: ReadonlyArray<MacState> }) {
  return (
    <Pressable
      onPress={() => router.push("/macs")}
      className="bg-surface-secondary mx-4 mt-2 mb-1 rounded-2xl px-4 py-3"
    >
      <Text className="text-[14px] text-foreground">
        {macs.length === 1 ? `Can't reach ${macs[0]?.mac.name}` : `Can't reach ${macs.length} Macs`}
      </Text>
      <Text className="text-[13px] text-muted">
        {macs.some((mac) => mac.connection === "unpaired" || mac.connection === "outdated")
          ? "Tap to see why."
          : "Retrying. Check the Mac is awake with MassCode open, and Tailscale is on."}
      </Text>
    </Pressable>
  );
}

function ThreadRowView({ row, showMac }: { row: ThreadRow; showMac: boolean }) {
  const { thread } = row;
  const needsYou = NEEDS_YOU[thread.status];
  const isUnread = thread.seenRev < thread.updatedAt;
  const request = thread.request;
  const now = useNow();

  function respond(decision: "allow" | "deny") {
    if (!request) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    send(
      row.macId,
      ClientCommand.cases["approval.respond"].make({
        threadId: thread.id,
        requestId: request.requestId,
        decision,
      }),
    );
  }

  return (
    <Pressable
      onPress={() => router.push(`/thread/${row.macId}/${thread.id}`)}
      className="active:bg-surface-secondary flex-row gap-3 px-4 py-3"
    >
      <View className="w-2 items-center pt-2">
        <View className={`size-2 rounded-full ${findDotTone(thread, isUnread)}`} />
      </View>
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text
            numberOfLines={1}
            className={
              isUnread
                ? "flex-1 text-[16px] font-semibold text-foreground"
                : "flex-1 text-[16px] text-foreground"
            }
          >
            {thread.title || "New thread"}
          </Text>
          <Text className={`text-[13px] ${needsYou?.labelTone ?? "text-muted"}`}>
            {needsYou?.label ?? formatAge(thread.updatedAt, now)}
          </Text>
        </View>
        <Text numberOfLines={1} className="text-[14px] text-muted">
          {thread.status === "running"
            ? describeActivity(thread.activity)
            : [row.projectName, showMac ? row.macName : null].filter(Boolean).join(" · ")}
        </Text>
        {request && !request.asksQuestions ? (
          <View className="bg-surface-secondary mt-2 gap-2 rounded-xl p-3">
            <Text numberOfLines={3} className="font-mono text-[13px] text-foreground">
              {request.detail || request.title}
            </Text>
            <View className="flex-row gap-2">
              <Button size="sm" onPress={() => respond("allow")}>
                Allow
              </Button>
              <Button size="sm" variant="secondary" onPress={() => respond("deny")}>
                Deny
              </Button>
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
