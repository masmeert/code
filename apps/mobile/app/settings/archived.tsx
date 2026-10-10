import { formatAge, formatProjectLabel, useNow } from "@masscode/client";
import { ClientCommand } from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import { FlatList, View } from "react-native";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/cn.ts";
import { send, useStore } from "@/lib/store.ts";

export default function ArchivedThreadsScreen() {
  const hosts = useStore((state) => state.hosts);
  const now = useNow();
  const hasManyHosts = Object.keys(hosts).length > 1;

  const rows = Object.entries(hosts)
    .flatMap(([hostId, host]) =>
      Object.values(host.threads)
        .filter((thread) => thread.archivedAt !== null)
        .map((thread) => ({
          hostId,
          thread,
          project: formatProjectLabel(
            host.projects.find((project) => project.id === thread.projectId)?.name ?? "",
            hasManyHosts ? host.paired.name : null,
          ),
        })),
    )
    .sort((left, right) => (right.thread.archivedAt ?? 0) - (left.thread.archivedAt ?? 0));

  return (
    <FlatList
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="p-4"
      data={rows}
      keyExtractor={(row) => `${row.hostId}/${row.thread.id}`}
      ListEmptyComponent={
        <Text className="p-8 text-center text-sm text-muted-foreground">
          No archived threads. Swipe a thread left in the list to archive it.
        </Text>
      }
      renderItem={({ item, index }) => (
        <View
          className={cn(
            "flex-row items-center gap-3 bg-card py-3 pr-2 pl-4",
            index === 0 && "rounded-t-2xl",
            index === rows.length - 1 && "rounded-b-2xl",
          )}
        >
          <View className="flex-1 gap-0.5">
            <Text numberOfLines={1} className="text-[16px] font-medium">
              {item.thread.title || "New thread"}
            </Text>
            <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
              {item.project} · {formatAge(item.thread.archivedAt ?? item.thread.updatedAt, now)}
            </Text>
          </View>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              send(
                item.hostId,
                ClientCommand.cases["thread.archive"].make({
                  threadId: item.thread.id,
                  archived: false,
                }),
              );
            }}
          >
            <Text className="text-brand">Restore</Text>
          </Button>
        </View>
      )}
    />
  );
}
