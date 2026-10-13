import { getProjectKey } from "@masscode/client";
import type { Project } from "@masscode/contracts";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { ProjectBadge } from "@/components/project-badge.tsx";
import { FormButtonRow, FormLinkRow, FormList, FormSection } from "@/components/form-list.tsx";
import { type HostState, useStore } from "@/lib/store.ts";

export default function ChooseProjectScreen() {
  const hosts = useStore((state) => state.hosts);
  const [query, setQuery] = useState("");

  const hostList = Object.values(hosts).filter((host) => host.connection !== "off");

  // One row per repo, however many computers have a copy of it.
  const copiesByKey = new Map<string, Array<{ host: HostState; project: Project }>>();

  for (const host of hostList)
    for (const project of host.projects) {
      const key = getProjectKey(project);

      copiesByKey.set(key, [...(copiesByKey.get(key) ?? []), { host, project }]);
    }

  const groups = [...copiesByKey.values()];

  const matches = groups.filter((copies) =>
    copies.some(({ project }) =>
      `${project.name} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

  return (
    <>
      <>
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="xmark"
            accessibilityLabel="Cancel"
            onPress={() => router.back()}
          />
        </Stack.Toolbar>
        {groups.length > 0 ? (
          <Stack.Toolbar>
            <Stack.Toolbar.SearchBarSlot />
          </Stack.Toolbar>
        ) : null}
      </>
      {groups.length > 0 ? (
        <Stack.SearchBar
          placeholder="Search projects"
          onChangeText={(event) => setQuery(event.nativeEvent.text)}
          onCancelButtonPress={() => setQuery("")}
        />
      ) : null}
      <FormList>
        {groups.length === 0 ? (
          <NoProjects hosts={hostList} />
        ) : (
          <FormSection
            footer={
              matches.length === 0
                ? "No matching projects. Try a different project name or path."
                : undefined
            }
          >
            {matches.map((copies) => {
              // Opens on a computer that's connected now; the draft can switch to another copy.
              const target =
                copies.find(({ host }) => host.connection === "connected") ?? copies[0];

              if (!target) return null;

              return (
                <FormLinkRow
                  key={getProjectKey(target.project)}
                  leading={<ProjectBadge project={target.project} />}
                  label={target.project.name}
                  detail={
                    copies.length > 1
                      ? `On ${copies.map(({ host }) => host.paired.name).join(", ")}`
                      : hostList.length > 1
                        ? `${target.host.paired.name} · ${target.project.path}`
                        : target.project.path
                  }
                  onPress={() =>
                    router.replace({
                      pathname: "/thread/[hostId]/new",
                      params: { hostId: target.host.paired.id, path: target.project.path },
                    })
                  }
                />
              );
            })}
          </FormSection>
        )}
      </FormList>
    </>
  );
}

function NoProjects({ hosts }: { hosts: ReadonlyArray<HostState> }) {
  const isConnecting = hosts.some((host) => host.connection === "connecting");
  const isConnected = hosts.some((host) => host.connection === "connected");

  const [title, detail] =
    hosts.length === 0
      ? [
          "No computers connected",
          "Pair this phone with MassCode on your computer, or turn one on in Settings → Computers.",
        ]
      : isConnecting && !isConnected
        ? ["Connecting…", "Loading projects from your computers."]
        : !isConnected
          ? [
              "Can't reach your computers",
              "Check they're awake with MassCode open, and Tailscale is on here and there.",
            ]
          : ["No projects yet", "Add a project in MassCode on your computer to start a thread."];

  return (
    <FormSection title={title} footer={detail}>
      {hosts.length === 0 ? (
        <FormButtonRow label="Pair a computer" onPress={() => router.push("/pair")} />
      ) : null}
    </FormSection>
  );
}
