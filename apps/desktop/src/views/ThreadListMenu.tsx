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
import { Tooltip } from "@apcode/ui/motion/tooltip";
import { cn } from "@apcode/ui/lib/utils";
import { ProjectBadge } from "@/components/project-badge";
import type { Project } from "@apcode/contracts";
import { SlidersHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { PROVIDER_LABEL } from "../lib/models.ts";
import { DEFAULT_THREAD_LIST_VIEW, type ThreadListView } from "../lib/threadListView.ts";

function OptionMenu(props: { label: string; value: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {props.label}
        <span className="ml-auto min-w-0 truncate pl-4 text-muted-foreground">{props.value}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent collisionPadding={8} className="max-h-(--radix-dropdown-menu-content-available-height) max-w-64 overflow-y-auto">
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
      <DropdownMenuRadioGroup value={props.value} onValueChange={(value) => props.onChange(value as Value)}>
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
  const [open, setOpen] = useState(false);
  const filtered = view.status !== "active" || view.projects.length > 0 || view.provider !== "all" || view.activity !== "any";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip content="View options" side="bottom" open={open ? false : undefined}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="View options" className="relative size-7">
            <SlidersHorizontal className={cn("size-4", filtered && "text-foreground")} />
            {filtered ? <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground" /> : null}
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={8} collisionPadding={8} className="w-60">
        <ChoiceMenu
          label="Status"
          value={view.status}
          labels={{ active: "Active", archived: "Archived", all: "All" }}
          onChange={(status) => props.onChange({ status })}
        />
        <OptionMenu
          label="Project"
          value={
            view.projects.length === 0
              ? "All"
              : view.projects.length === 1
                ? props.projects.find((project) => project.id === view.projects[0])?.name
                : `${view.projects.length} projects`
          }
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
                props.onChange({ projects: checked ? [...view.projects, project.id] : view.projects.filter((id) => id !== project.id) })
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
            <DropdownMenuItem onSelect={() => props.onChange({ ...DEFAULT_THREAD_LIST_VIEW, groupBy: view.groupBy, sortBy: view.sortBy })}>
              Clear filters
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
