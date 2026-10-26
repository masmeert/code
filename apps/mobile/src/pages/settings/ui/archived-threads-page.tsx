import { formatAge, formatProjectLabel, useNow } from "@masscode/client";
import { ClientCommand } from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import { alertNotConnected, useHostStore } from "@/entities/host";
import { useProjectStore } from "@/entities/project";
import { useThreadStore } from "@/entities/thread";
import { send } from "@/shared/api";
import { FormActionRow, FormList, FormSection } from "@/shared/ui";

export function ArchivedThreadsPage() {
  const hosts = useHostStore((state) => state.hosts);
  const threadsByHost = useThreadStore((state) => state.threads);
  const projectsByHost = useProjectStore((state) => state.projects);
  const now = useNow();
  const hasManyHosts = Object.keys(hosts).length > 1;

  const rows = Object.entries(hosts)
    .flatMap(([hostId, host]) =>
      Object.values(threadsByHost[hostId] ?? {})
        .filter((thread) => thread.archivedAt !== null)
        .map((thread) => ({
          hostId,
          thread,
          project: formatProjectLabel(
            (projectsByHost[hostId] ?? []).find((project) => project.id === thread.projectId)
              ?.name ?? "",
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
            : rows.some((row) => hosts[row.hostId]?.connection !== "connected")
              ? "Restoring puts a thread back in the list. Threads on a computer that isn't connected can be restored once it's back."
              : "Restoring puts a thread back in the list."
        }
      >
        {rows.map((row) => (
          <FormActionRow
            key={`${row.hostId}/${row.thread.id}`}
            label={row.thread.title || "New thread"}
            detail={`${row.project} · ${formatAge(row.thread.archivedAt ?? row.thread.updatedAt, now)}`}
            actionLabel="Restore"
            isDisabled={hosts[row.hostId]?.connection !== "connected"}
            onPress={() => {
              if (
                !send(
                  row.hostId,
                  ClientCommand.cases["thread.archive"].make({
                    threadId: row.thread.id,
                    archived: false,
                  }),
                )
              )
                return alertNotConnected(row.hostId);

              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          />
        ))}
      </FormSection>
    </FormList>
  );
}
