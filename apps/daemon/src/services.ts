import type { Service } from "@masscode/contracts";
import { realpathSync } from "node:fs";

const SCAN_INTERVAL_MS = 5000;

const FOLLOW_UP_SCAN_MS = [0, 1000, 3000];

const STOP_TIMEOUT_MS = 3000;

const MAX_COMMAND_LENGTH = 500;

interface ProcessRow {
  readonly parentPid: number;
  readonly command: string;
}

interface Listener {
  readonly name: string;
  readonly ports: ReadonlyArray<number>;
}

/** What started a process: a thread's agent, or one of its terminals. */
interface Owner {
  readonly threadId: string;
  readonly terminalId?: string;
  readonly script?: string;
}

interface ThreadFolder {
  readonly id: string;
  readonly cwd: string;
  readonly updatedAt: number;
}

export type Services = ReturnType<typeof createServices>;

/** What `command` prints; empty when it fails or is missing (lsof isn't on every Linux host). */
export async function readCommandOutput(command: ReadonlyArray<string>) {
  try {
    return await new Response(
      Bun.spawn([...command], { stdout: "pipe", stderr: "ignore" }).stdout,
    ).text();
  } catch {
    return "";
  }
}

async function readProcesses() {
  const processes = new Map<number, ProcessRow>();

  for (const line of (await readCommandOutput(["ps", "-A", "-ww", "-o", "pid=,ppid=,args="])).split(
    "\n",
  )) {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);

    if (match)
      processes.set(Number(match[1]), {
        parentPid: Number(match[2]),
        command: (match[3] ?? "").trim().slice(0, MAX_COMMAND_LENGTH),
      });
  }

  return processes;
}

/** lsof's -F output: one field per line, each process's starting with `p<pid>`. */
async function readListeners() {
  const listeners = new Map<number, { name: string; ports: Set<number> }>();
  let current: { name: string; ports: Set<number> } | undefined;

  for (const line of (
    await readCommandOutput(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
  ).split("\n")) {
    const value = line.slice(1);

    if (line.startsWith("p")) {
      current = { name: "", ports: new Set() };
      listeners.set(Number(value), current);
    } else if (current && line.startsWith("c")) current.name = value;
    else if (current && line.startsWith("n")) {
      const port = Number(value.slice(value.lastIndexOf(":") + 1));

      if (Number.isInteger(port) && port > 0) current.ports.add(port);
    }
  }

  return new Map(
    [...listeners].map(([pid, { name, ports }]): [number, Listener] => [
      pid,
      { name, ports: [...ports].sort((left, right) => left - right) },
    ]),
  );
}

async function readWorkingDirectories(pids: ReadonlyArray<number>) {
  const folders = new Map<number, string>();

  if (pids.length === 0) return folders;

  let pid = 0;

  for (const line of (
    await readCommandOutput(["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fn"])
  ).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) folders.set(pid, line.slice(1));
  }

  return folders;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function signalAll(pids: ReadonlyArray<number>, signal: NodeJS.Signals) {
  for (const pid of pids)
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
}

async function waitForExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(100);

  return !isAlive(pid);
}

function listAncestors(pid: number, processes: ReadonlyMap<number, ProcessRow>) {
  const ancestors: Array<number> = [];

  for (let current = pid; current > 1 && !ancestors.includes(current);) {
    ancestors.push(current);
    current = processes.get(current)?.parentPid ?? 0;
  }

  return ancestors;
}

function listDescendants(pid: number, processes: ReadonlyMap<number, ProcessRow>) {
  const descendants: Array<number> = [];

  for (const [child, row] of processes)
    if (row.parentPid === pid) descendants.push(child, ...listDescendants(child, processes));

  return descendants;
}

function toService(
  owner: Owner,
  pid: number,
  listener: Listener,
  processes: ReadonlyMap<number, ProcessRow>,
): Service {
  return {
    ...owner,
    pid,
    ports: listener.ports,
    name: listener.name,
    command: processes.get(pid)?.command ?? listener.name,
  };
}

/** lsof reports resolved folders: /private/tmp for /tmp. */
function resolveFolder(folder: string) {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

function isInside(folder: string, parent: string) {
  return folder === parent || folder.startsWith(`${parent}/`);
}

/**
 * Finds the processes listening on TCP ports that threads started, so they can be stopped once the
 * agent that started them forgot to. A process belongs to the thread whose agent or terminal it
 * descends from; one orphaned to launchd (`npm run dev &` in a shell that exited) to the thread
 * whose folder it was started in.
 */
export function createServices(options: {
  listThreads(): Iterable<ThreadFolder>;
  onChanged(services: ReadonlyArray<Service>): void;
}) {
  /** Agent and terminal processes, by pid: what they start is their thread's. */
  const owners = new Map<number, Owner>();
  let services: ReadonlyArray<Service> = [];
  let scanning: Promise<void> | null = null;

  function findFolderThread(folder: string) {
    let best: ThreadFolder | null = null;

    for (const listed of options.listThreads()) {
      const thread = { ...listed, cwd: resolveFolder(listed.cwd) };

      if (
        isInside(folder, thread.cwd) &&
        (best === null ||
          thread.cwd.length > best.cwd.length ||
          (thread.cwd.length === best.cwd.length && thread.updatedAt > best.updatedAt))
      )
        best = thread;
    }

    return best?.id ?? null;
  }

  async function readServices() {
    const [processes, listeners] = await Promise.all([readProcesses(), readListeners()]);

    for (const pid of owners.keys()) if (!isAlive(pid)) owners.delete(pid);

    // MassCode's own processes, the daemon and the app above it, are never a thread's.
    const ownChain = new Set(listAncestors(process.pid, processes));
    const owned: Array<Service> = [];

    const orphans: Array<{
      readonly pid: number;
      readonly root: number;
      readonly listener: Listener;
    }> = [];

    for (const [pid, listener] of listeners) {
      if (owners.has(pid) || ownChain.has(pid) || listener.ports.length === 0) continue;

      const ancestors = listAncestors(pid, processes);

      const owner = ancestors
        .map((ancestor) => owners.get(ancestor))
        .find((candidate) => candidate !== undefined);

      const root = ancestors.at(-1);

      if (owner !== undefined) owned.push(toService(owner, pid, listener, processes));
      else if (
        root !== undefined &&
        processes.get(root)?.parentPid === 1 &&
        !ancestors.some((ancestor) => ownChain.has(ancestor))
      )
        orphans.push({ pid, root, listener });
    }

    const folders = await readWorkingDirectories([...new Set(orphans.map(({ root }) => root))]);

    for (const { pid, root, listener } of orphans) {
      const folder = folders.get(root);
      const threadId = folder === undefined ? null : findFolderThread(folder);

      if (threadId !== null) owned.push(toService({ threadId }, pid, listener, processes));
    }

    return owned.sort((left, right) => (left.ports[0] ?? 0) - (right.ports[0] ?? 0));
  }

  function scan() {
    scanning ??= readServices()
      .then((next) => {
        if (JSON.stringify(next) === JSON.stringify(services)) return;

        services = next;
        options.onChanged(services);
      })
      .finally(() => (scanning = null));

    return scanning;
  }

  /** Resolves to why the service couldn't be stopped, or null once it's gone. */
  async function stop(service: Service) {
    const processes = await readProcesses();

    // The pid went to another process since the scan.
    if (processes.get(service.pid)?.command !== service.command) return null;

    // What it started goes with it, so a watcher or worker doesn't take the port back.
    const targets = [service.pid, ...listDescendants(service.pid, processes)].filter(
      (target) => !owners.has(target) && target !== process.pid,
    );

    signalAll(targets, "SIGTERM");

    if (!(await waitForExit(service.pid, STOP_TIMEOUT_MS))) {
      signalAll(targets.filter(isAlive), "SIGKILL");
      await waitForExit(service.pid, 1000);
    }

    await scan();

    return isAlive(service.pid)
      ? `${service.name} (pid ${service.pid}) didn't stop. Stop it from a terminal with: kill -9 ${service.pid}`
      : null;
  }

  const timer = setInterval(() => void scan(), SCAN_INTERVAL_MS);
  void scan();

  return {
    list: () => services,
    track(threadId: string, pid: number | undefined, terminal?: Omit<Owner, "threadId">) {
      if (pid !== undefined) owners.set(pid, { threadId, ...terminal });
    },
    /** Scans now and again over the next seconds, while a server started from a terminal binds its port or one that ended lets go. */
    refresh() {
      for (const delayMs of FOLLOW_UP_SCAN_MS) setTimeout(() => void scan(), delayMs);
    },
    async kill(threadId: string, pid: number) {
      await scan();

      const service = services.find(
        (candidate) => candidate.threadId === threadId && candidate.pid === pid,
      );

      return service ? stop(service) : null;
    },
    /** Takes the services as of the last scan, while the thread is still there to match orphans to. */
    killThread(threadId: string) {
      void (async () => {
        for (const service of services.filter((candidate) => candidate.threadId === threadId))
          await stop(service);
      })();
    },
    close() {
      clearInterval(timer);
    },
  };
}
