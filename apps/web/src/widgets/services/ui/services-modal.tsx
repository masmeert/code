import { Button } from "@masmeert/ui/button";
import { ScrollArea } from "@masmeert/ui/scroll-area";
import { formatProjectLabel } from "@masscode/client";
import { MorphingModal } from "@masscode/ui/motion/morphing-modal";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { buildFallbackProject, ProjectBadge, useProjectStore } from "@/entities/project";
import { type HostedService, killService, useServices } from "@/entities/service";
import { useThreadStore } from "@/entities/thread";

/** The ports threads' agents and terminals left listening, across every host, to stop the forgotten ones. */
export function ServicesModal({
  isOpen,
  onClose,
  onSelectThread,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelectThread: (threadId: string) => void;
}) {
  return (
    <MorphingModal
      viewId={isOpen ? "services" : null}
      onClose={onClose}
      placement="center"
      className="max-w-xl"
    >
      {isOpen ? (
        <ServicesView
          onSelectThread={(threadId) => {
            onSelectThread(threadId);
            onClose();
          }}
        />
      ) : null}
    </MorphingModal>
  );
}

function getServiceKey(service: HostedService) {
  return `${service.host ?? ""}:${service.pid}`;
}

function ServicesView({ onSelectThread }: { onSelectThread: (threadId: string) => void }) {
  const services = useServices();
  const threads = useThreadStore((state) => state.threads);
  const projects = useProjectStore((state) => state.projects);
  const [killing, setKilling] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  async function kill(targets: ReadonlyArray<HostedService>) {
    const keys = targets.map(getServiceKey);

    setKilling((current) => new Set([...current, ...keys]));
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key))),
    );

    await Promise.all(
      targets.map(async (service) => {
        const error = await killService(service);

        if (error) setErrors((current) => ({ ...current, [getServiceKey(service)]: error }));
      }),
    );

    setKilling((current) => new Set([...current].filter((key) => !keys.includes(key))));
  }

  return (
    <div className="-m-5 flex max-h-[min(36rem,calc(100vh-4rem))] flex-col">
      <h2 className="shrink-0 px-5 pt-4 pb-3 text-sm font-medium">Services</h2>
      {services.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">
          Nothing is listening. Servers that agents or terminals start show up here.
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 px-3 pb-4">
            {[...new Set(services.map((service) => service.threadId))].map((threadId) => {
              const info = threads[threadId];
              const owned = services.filter((service) => service.threadId === threadId);

              const project = info
                ? (projects.find((candidate) => candidate.id === info.projectId) ??
                  buildFallbackProject(info.projectId, info.cwd))
                : null;

              return (
                <section key={threadId} className="flex flex-col gap-0.5">
                  <div className="flex h-8 items-center gap-2 px-2">
                    {project ? <ProjectBadge project={project} /> : null}
                    <button
                      type="button"
                      onClick={() => onSelectThread(threadId)}
                      className="min-w-0 truncate rounded text-left text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {info?.title || "Untitled thread"}
                    </button>
                    {project ? (
                      <span className="min-w-0 shrink-0 truncate text-xs text-muted-foreground">
                        {formatProjectLabel(project.name, owned[0]?.host ?? null)}
                      </span>
                    ) : null}
                    {owned.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={owned.every((service) => killing.has(getServiceKey(service)))}
                        onClick={() => void kill(owned)}
                        className="ml-auto h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
                      >
                        Kill all
                      </Button>
                    ) : null}
                  </div>
                  {owned.map((service) => {
                    const key = getServiceKey(service);
                    const isKilling = killing.has(key);

                    return (
                      <div
                        key={key}
                        className="flex flex-col rounded-lg px-2 py-1.5 hover:bg-muted/40"
                      >
                        <div className="flex items-center gap-3">
                          <span className="shrink-0 font-mono text-sm tabular-nums">
                            {service.ports.map((port) => `:${port}`).join(" ")}
                          </span>
                          <span
                            title={service.command}
                            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                          >
                            <span className="text-foreground/80">{service.name}</span>{" "}
                            <span className="font-mono">{service.command}</span>
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isKilling}
                            onClick={() => void kill([service])}
                            aria-label={`Kill ${service.name} on port ${service.ports.join(", ")}`}
                            className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
                          >
                            {isKilling ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                            {isKilling ? "Killing…" : "Kill"}
                          </Button>
                        </div>
                        {errors[key] ? (
                          <p className="pt-1 text-xs text-destructive">{errors[key]}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
