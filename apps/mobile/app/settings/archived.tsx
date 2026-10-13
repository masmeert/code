import { formatAge, formatProjectLabel, useNow } from "@masscode/client";
import { ClientCommand } from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import { FormActionRow, FormList, FormSection } from "@/components/form-list.tsx";
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
    <FormList>
      <FormSection
        footer={
          rows.length === 0
            ? "No archived threads. Swipe a thread left in the list to archive it."
            : "Restoring puts a thread back in the list."
        }
      >
        {rows.map((row) => (
          <FormActionRow
            key={`${row.hostId}/${row.thread.id}`}
            label={row.thread.title || "New thread"}
            detail={`${row.project} · ${formatAge(row.thread.archivedAt ?? row.thread.updatedAt, now)}`}
            actionLabel="Restore"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              send(
                row.hostId,
                ClientCommand.cases["thread.archive"].make({
                  threadId: row.thread.id,
                  archived: false,
                }),
              );
            }}
          />
        ))}
      </FormSection>
    </FormList>
  );
}
