import type { Project } from "@apcode/contracts";
import { cn } from "@/lib/utils";

const TINTS = [
  "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
];

/** "my-app" → "MA", "APSchool" → "AP". */
const initials = (name: string) => {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
};

const tint = (key: string) => {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length]!;
};

/** Two-letter project mark, tinted per project so they're told apart at a glance. */
export const ProjectBadge = ({ project, className }: { project: Pick<Project, "id" | "name">; className?: string }) => (
  <span
    aria-hidden="true"
    className={cn(
      "grid size-4 shrink-0 place-items-center rounded-[4px] text-[8.5px] leading-none font-semibold tracking-tight",
      tint(project.id),
      className,
    )}
  >
    {initials(project.name)}
  </span>
);
