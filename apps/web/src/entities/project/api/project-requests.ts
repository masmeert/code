import { ClientCommand, type ProjectConfig } from "@masscode/contracts";
import { sendRequest } from "@/shared/api";
import { rememberPendingPath } from "../model/project-store.ts";

/** The folders in `path` on `host`, `path` made absolute; null when the host doesn't answer. */
export function listFolders(host: string | null, path: string) {
  return sendRequest(
    host,
    ClientCommand.cases["folder.list"].make({ path, requestId: crypto.randomUUID() }),
    "folder.entries",
    10_000,
  );
}

/** Clones a repository into a new folder under `parent` on `host` and adds it as a project. */
export async function cloneProject(
  host: string | null,
  url: string,
  parent: string,
  folder?: string,
  name?: string,
) {
  const cloned = await sendRequest(
    host,
    ClientCommand.cases["project.clone"].make({
      url,
      parent,
      folder,
      name,
      requestId: crypto.randomUUID(),
    }),
    "project.cloned",
    // Big repositories take a while; the daemon gives up at 10 minutes.
    11 * 60_000,
  );

  if (cloned?.path && host !== null) rememberPendingPath(cloned.path, host);

  return (
    cloned ?? {
      path: null,
      error: "The host stopped answering. Check its connection, then retry.",
    }
  );
}

/** The project's `masscode.toml` on `host`; null when the host doesn't answer. */
export function readProjectConfig(host: string | null, path: string) {
  return sendRequest(
    host,
    ClientCommand.cases["project.config"].make({ path, requestId: crypto.randomUUID() }),
    "project.config",
    10_000,
  );
}

/**
 * Reads the project's `masscode.toml` on `host` afresh, so edits made elsewhere since aren't lost,
 * and saves what `change` makes of it; resolves to what kept it from saving, or null.
 */
export async function updateProjectConfig(
  host: string | null,
  path: string,
  change: (config: ProjectConfig) => ProjectConfig,
) {
  const current = await readProjectConfig(host, path);

  const saved =
    current &&
    (await sendRequest(
      host,
      ClientCommand.cases["project.saveConfig"].make({
        path,
        config: change(current.config),
        requestId: crypto.randomUUID(),
      }),
      "project.configSaved",
      10_000,
    ));

  return saved
    ? saved.error
    : "MassCode's daemon didn't answer, so nothing was saved. Check it's running and try again.";
}
