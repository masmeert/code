import type { Project } from "@masscode/contracts";
import { getProjectInitials, getProjectTint } from "@masscode/client";
import { cn } from "@masscode/ui/lib/utils";

/** Two-letter project mark, tinted per project (the same on every machine) so they're told apart at a glance. */
export function ProjectBadge({
  project,
  className,
}: {
  project: Pick<Project, "id" | "name" | "remote" | "folder">;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] text-[8.5px] leading-none font-semibold",
        getProjectTint(project).background,
        getProjectTint(project).text,
        className,
      )}
    >
      {getProjectInitials(project.name)}
    </span>
  );
}
