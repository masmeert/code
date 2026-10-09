import type { Project } from "@masscode/contracts";

/** Stands in for a project missing from the list, such as one since removed, named after its folder. */
export function buildFallbackProject(id: string, path: string): Project {
  return { id, name: path.split("/").at(-1) ?? path, path, addedAt: 0 };
}
