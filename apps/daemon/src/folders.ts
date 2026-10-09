import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function expandHome(path: string) {
  return path.trim().replace(/^~(?=\/|$)/, homedir());
}

/** The folders inside `path`, for picking a project on a machine the app can't show a native dialog for. */
export async function listFolders(path: string) {
  const absolute = resolve(expandHome(path) || homedir());
  try {
    const entries = await readdir(absolute, { withFileTypes: true });
    return {
      path: absolute,
      folders: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right)),
      error: null,
    };
  } catch (error) {
    return {
      path: absolute,
      folders: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
