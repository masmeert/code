import type { Project } from "@masscode/contracts";
import { getProjectKey } from "../lib/projects.ts";
import { cn } from "@masscode/ui/lib/utils";

const TINTS = [
  "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
];

/** "my-app" → "MA", "APSchool" → "AP". */
function getInitials(name: string) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
}

function getProjectTint(key: string) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length];
}

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
        "grid size-4 shrink-0 place-items-center rounded-[4px] text-[8.5px] leading-none font-semibold tracking-tight",
        getProjectTint(getProjectKey(project)),
        className,
      )}
    >
      {getInitials(project.name)}
    </span>
  );
}

/** A project's name, and the remote host it's on when it isn't on this Mac. */
export function formatProjectLabel(name: string, host: string | null | undefined) {
  return host ? `${name} on ${host}` : name;
}
