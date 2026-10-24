import { Collapsible } from "@masmeert/ui/collapsible";
import { useRowCursor } from "@masmeert/ui/hooks/use-row-cursor";
import { formatProjectLabel } from "@masscode/client";
import { cn } from "@masscode/ui/lib/utils";
import { MorphingModal } from "@masscode/ui/motion/morphing-modal";
import { ArrowUpRight, ChevronRight, EthernetPort, LoaderCircle, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { openPreview } from "@/entities/browser";
import { buildFallbackProject, ProjectBadge, useProjectStore } from "@/entities/project";
import { type HostedService, killService, useServices } from "@/entities/service";
import { useThreadStore } from "@/entities/thread";
import { IconButton } from "@/shared/ui";

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
      className="max-w-2xl"
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

/** What's serving, named by the package a runtime runs (`node …/vite.js` is vite), else by its executable. */
function describeProgram(service: HostedService) {
  return (
    service.command
      .split(/\s+/)
      .find((token) => token.includes("/node_modules/"))
      ?.match(/.*\/node_modules\/(?:\.bin\/)?((?:@[^/]+\/)?[^/]+)/)?.[1] ?? service.name
  );
}

/** Remote ports aren't reachable from this Mac's browser. */
function canPreview(service: HostedService) {
  return window.desktop !== undefined && !service.host;
}

function ServicesView({ onSelectThread }: { onSelectThread: (threadId: string) => void }) {
  const services = useServices();
  const threads = useThreadStore((state) => state.threads);
  const projects = useProjectStore((state) => state.projects);
  const [killing, setKilling] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // A row stays selected for the keys, but isn't highlighted while the pointer is on a header.
  const [isOverHeader, setIsOverHeader] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  // Sorted the way they're shown, project by project, so the arrow keys follow the screen.
  const rows = services
    .map((service) => {
      const info = threads[service.threadId];

      const project = info
        ? (projects.find((candidate) => candidate.id === info.projectId) ??
          buildFallbackProject(info.projectId, info.cwd))
        : null;

      return {
        id: getServiceKey(service),
        service,
        program: describeProgram(service),
        threadTitle: info?.title || "Untitled thread",
        project,
        projectLabel: project ? formatProjectLabel(project.name, service.host) : "Unknown project",
      };
    })
    .sort(
      (first, second) =>
        first.projectLabel.localeCompare(second.projectLabel) ||
        (first.service.ports[0] ?? 0) - (second.service.ports[0] ?? 0),
    );

  const projectLabels = [...new Set(rows.map((row) => row.projectLabel))];
  const shownRows = rows.filter((row) => !collapsed.has(row.projectLabel));
  const { activeIndex, moveTo, moveActive } = useRowCursor(shownRows, "");
  const activeId = shownRows[activeIndex]?.id;

  function open(service: HostedService) {
    onSelectThread(service.threadId);

    if (canPreview(service) && service.ports[0] !== undefined)
      openPreview(service.threadId, `http://localhost:${service.ports[0]}/`);
  }

  async function kill(service: HostedService) {
    const key = getServiceKey(service);

    if (killing.has(key)) return;
    setKilling((current) => new Set([...current, key]));
    setErrors(({ [key]: _cleared, ...rest }) => rest);

    const error = await killService(service);

    if (error) setErrors((current) => ({ ...current, [key]: error }));
    setKilling((current) => new Set([...current].filter((candidate) => candidate !== key)));
  }

  // The modal keeps focus on its panel, so the list's keys are read from the window.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const active = shownRows[activeIndex]?.service;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setIsOverHeader(false);
        moveActive(event.key === "ArrowDown" ? 1 : -1);
      } else if (!active) {
        return;
      } else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        open(active);
      } else if (event.metaKey && (event.key === "Backspace" || event.key === "Delete")) {
        event.preventDefault();
        void kill(active);
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    list.current
      ?.querySelector(`[data-service="${activeId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <div className="-m-5 flex max-h-[min(34rem,calc(100vh-4rem))] flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted text-foreground">
          <EthernetPort className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] leading-5 font-semibold">Services</h2>
          <p className="text-xs text-muted-foreground">
            {rows.length === 0
              ? "Nothing running"
              : `${rows.length} running across ${projectLabels.length} ${projectLabels.length === 1 ? "project" : "projects"}`}
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted-foreground">
          Nothing is listening. Servers that agents or terminals start show up here.
        </p>
      ) : (
        <div
          ref={list}
          role="listbox"
          aria-label="Services"
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2 pb-2"
        >
          {projectLabels.map((label) => {
            const grouped = rows.filter((row) => row.projectLabel === label);
            const isCollapsed = collapsed.has(label);

            return (
              <section key={label} className="flex flex-col not-first:mt-2">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onMouseEnter={() => setIsOverHeader(true)}
                  onMouseLeave={() => setIsOverHeader(false)}
                  onClick={() =>
                    setCollapsed((current) =>
                      isCollapsed
                        ? new Set([...current].filter((candidate) => candidate !== label))
                        : new Set([...current, label]),
                    )
                  }
                  className={cn(
                    "flex h-10 w-full shrink-0 items-center gap-2.5 rounded-xl px-3 text-left text-[13px] font-medium text-foreground transition-colors outline-none hover:bg-muted/50 focus-visible:ring-4 focus-visible:ring-ring",
                    !isCollapsed && "sticky top-0 z-10 bg-background hover:bg-background",
                  )}
                >
                  {grouped[0]?.project ? <ProjectBadge project={grouped[0].project} /> : null}
                  <span className="min-w-0 truncate">{label}</span>
                  <span className="ml-auto rounded-full bg-muted px-1.5 py-px text-[11px] leading-4 font-normal text-muted-foreground tabular-nums">
                    {grouped.length}
                  </span>
                  <ChevronRight
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                      !isCollapsed && "rotate-90",
                    )}
                  />
                </button>
                <Collapsible open={!isCollapsed}>
                  <div className="flex flex-col gap-0.5">
                    {grouped.map(({ id, service, program, threadTitle }) => {
                      const isActive = id === activeId && !isOverHeader;
                      const isKilling = killing.has(id);

                      return (
                        <div
                          key={id}
                          data-service={id}
                          role="option"
                          aria-selected={isActive}
                          title={service.command}
                          // Not mouseenter: rows scrolling under a resting pointer would take the highlight from the keyboard.
                          onMouseMove={isActive ? undefined : () => moveTo(id)}
                          onClick={() => open(service)}
                          className={cn(
                            "flex h-9 cursor-default items-center gap-3 rounded-xl pr-1.5 pl-3 transition-colors",
                            isActive && "bg-muted",
                            isKilling && "opacity-50",
                          )}
                        >
                          <span className="ml-6 w-14 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                            :{service.ports[0]}
                          </span>
                          <span className="w-24 shrink-0 truncate text-[13px] text-foreground">
                            {program}
                          </span>
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-xs",
                              errors[id] ? "selectable text-destructive" : "text-muted-foreground",
                            )}
                          >
                            {errors[id] ?? threadTitle}
                          </span>
                          {isKilling ? (
                            <LoaderCircle className="mr-1.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                          ) : (
                            <span
                              onClick={(event) => event.stopPropagation()}
                              className={cn(
                                "flex shrink-0 items-center",
                                !isActive && "pointer-events-none opacity-0",
                              )}
                            >
                              {canPreview(service) ? (
                                <IconButton
                                  label={`Open localhost:${service.ports[0]} (↵)`}
                                  onClick={() => open(service)}
                                  className="hover:bg-foreground/5"
                                >
                                  <ArrowUpRight className="size-3.5" />
                                </IconButton>
                              ) : null}
                              <IconButton
                                label={`Stop ${program} (⌘⌫)`}
                                onClick={() => void kill(service)}
                                className="hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Square className="size-3 fill-current" />
                              </IconButton>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Collapsible>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
