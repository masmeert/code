import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@apcode/ui/components/dropdown-menu";
import { Button } from "@apcode/ui/motion/button";
import { cn } from "@apcode/ui/lib/utils";
import { ProjectBadge } from "@/components/project-badge";
import type { Project } from "@apcode/contracts";
import * as Match from "effect/Match";
import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { PROVIDER_LABEL } from "../lib/models.ts";
import { DEFAULT_THREAD_LIST_VIEW, type ThreadListView } from "../lib/threadListView.ts";

function OptionMenu(props: { label: string; value: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="shrink-0">{props.label}</span>
        <span className="min-w-0 flex-1 truncate pl-4 text-right text-muted-foreground">
          {props.value}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        collisionPadding={8}
        className="max-h-(--radix-dropdown-menu-content-available-height) max-w-64 overflow-y-auto"
      >
        {props.children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ChoiceMenu<Value extends string>(props: {
  label: string;
  value: Value;
  labels: Record<Value, string>;
  onChange: (value: Value) => void;
}) {
  return (
    <OptionMenu label={props.label} value={props.labels[props.value]}>
      <DropdownMenuRadioGroup
        value={props.value}
        // SAFETY: the radio items below are rendered from the keys of `labels`, which are all `Value`s.
        onValueChange={(value) => props.onChange(value as Value)}
      >
        {Object.entries<string>(props.labels).map(([value, label]) => (
          <DropdownMenuRadioItem key={value} value={value}>
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </OptionMenu>
  );
}

export function ThreadListMenu(props: {
  view: ThreadListView;
  projects: ReadonlyArray<Project>;
  onChange: (patch: Partial<ThreadListView>) => void;
}) {
  const { view } = props;
  const filtered =
    view.status !== "active" ||
    view.projects.length > 0 ||
    view.provider !== "all" ||
    view.activity !== "any";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="View options"
          className={cn("size-7", filtered && "bg-muted/60 text-foreground")}
        >
          <SlidersHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} collisionPadding={8} className="w-60">
        <ChoiceMenu
          label="Status"
          value={view.status}
          labels={{ active: "Active", archived: "Archived", all: "All" }}
          onChange={(status) => props.onChange({ status })}
        />
        <OptionMenu
          label="Project"
          value={Match.value(view.projects.length).pipe(
            Match.when(0, () => "All"),
            Match.when(
              1,
              () => props.projects.find((project) => project.id === view.projects[0])?.name,
            ),
            Match.orElse((count) => `${count} projects`),
          )}
        >
          <DropdownMenuCheckboxItem
            checked={view.projects.length === 0}
            onCheckedChange={() => props.onChange({ projects: [] })}
            onSelect={(event) => event.preventDefault()}
          >
            All projects
          </DropdownMenuCheckboxItem>
          {props.projects.length > 0 ? <DropdownMenuSeparator /> : null}
          {props.projects.map((project) => (
            <DropdownMenuCheckboxItem
              key={project.id}
              checked={view.projects.includes(project.id)}
              onCheckedChange={(checked) =>
                props.onChange({
                  projects: checked
                    ? [...view.projects, project.id]
                    : view.projects.filter((id) => id !== project.id),
                })
              }
              onSelect={(event) => event.preventDefault()}
            >
              <ProjectBadge project={project} />
              <span className="min-w-0 truncate">{project.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </OptionMenu>
        <ChoiceMenu
          label="Harness"
          value={view.provider}
          labels={{ all: "All", ...PROVIDER_LABEL }}
          onChange={(provider) => props.onChange({ provider })}
        />
        <ChoiceMenu
          label="Last activity"
          value={view.activity}
          labels={{ any: "Any time", day: "24 hours", week: "7 days", month: "30 days" }}
          onChange={(activity) => props.onChange({ activity })}
        />
        <DropdownMenuSeparator />
        <ChoiceMenu
          label="Group by"
          value={view.groupBy}
          labels={{ state: "State", project: "Project", none: "None" }}
          onChange={(groupBy) => props.onChange({ groupBy })}
        />
        <ChoiceMenu
          label="Sort by"
          value={view.sortBy}
          labels={{ updated: "Last activity", created: "Created" }}
          onChange={(sortBy) => props.onChange({ sortBy })}
        />
        {filtered ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                props.onChange({
                  ...DEFAULT_THREAD_LIST_VIEW,
                  groupBy: view.groupBy,
                  sortBy: view.sortBy,
                })
              }
            >
              Clear filters
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
