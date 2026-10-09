import { type Project, parseRepository } from "@masscode/contracts";

/** The same repo and folder on every machine, so a project keeps its tint wherever it's cloned. */
export function getProjectKey(project: Pick<Project, "id" | "remote" | "folder">) {
  return project.remote ? `${parseRepository(project.remote)}#${project.folder ?? ""}` : project.id;
}

/** Apart, since native text doesn't take its color from the view around it. */
const PROJECT_TINTS = [
  { background: "bg-blue-500/15", text: "text-blue-600 dark:text-blue-400" },
  { background: "bg-violet-500/15", text: "text-violet-600 dark:text-violet-400" },
  { background: "bg-emerald-500/15", text: "text-emerald-600 dark:text-emerald-400" },
  { background: "bg-amber-500/15", text: "text-amber-600 dark:text-amber-400" },
  { background: "bg-rose-500/15", text: "text-rose-600 dark:text-rose-400" },
  { background: "bg-cyan-500/15", text: "text-cyan-600 dark:text-cyan-400" },
];

/** "my-app" → "MA", "APSchool" → "AP". */
export function getProjectInitials(name: string) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 2);

  return letters.toUpperCase();
}

/** The project's tint, the same on every machine. */
export function getProjectTint(project: Pick<Project, "id" | "remote" | "folder">) {
  let hash = 0;

  for (const char of getProjectKey(project)) hash = (hash * 31 + char.charCodeAt(0)) | 0;

  return PROJECT_TINTS[Math.abs(hash) % PROJECT_TINTS.length];
}

/** A project's name, and the remote host it's on when it isn't on this Mac. */
export function formatProjectLabel(name: string, host: string | null | undefined) {
  return host ? `${name} on ${host}` : name;
}
