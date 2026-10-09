import { browserPartition, HostStatus, type RemoteHost } from "@masscode/contracts";
import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline as pipeStreams, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app, BrowserWindow, net, session } from "electron";
import { configureBrowserSession } from "./browser.ts";
import { freePort } from "./freePort.ts";

/**
 * Remote hosts: each runs its own daemon, started over SSH and reached through a tunnel,
 * so its agents keep working while this Mac sleeps or goes offline. Uses the system `ssh`,
 * so ~/.ssh/config, keys, the agent and ProxyJump all apply as they do in a terminal.
 */

interface Daemon {
  readonly port: number;
  readonly token: string;
}

interface Host {
  readonly alias: string;
  status: HostStatus;
  connecting: Promise<Daemon | null> | null;
  tunnel: {
    readonly process: ChildProcess;
    readonly remotePort: number;
    readonly daemon: Daemon;
  } | null;
}

const hosts = new Map<string, Host>();

function listFile() {
  return join(app.getPath("userData"), "hosts.json");
}

/** Never asks for a password (there's no terminal to type it in), and gives up on a dead link. */
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

/** Strict enough to never need quoting in a remote command line. */
const VERSION_PATTERN = /^[\w.-]+$/;

/**
 * Run on the host with `sh -s -- <version> <start|restart|stop>`. Starts the daemon under a
 * supervisor loop that restarts it, on whatever version `bin/masscode-daemon` points to by then,
 * so an update only has to repoint it and ask the running daemon to exit once it's idle.
 */
const REMOTE_SCRIPT = String.raw`
set -eu
version="$1"
dir="$HOME/.masscode/remote"
mkdir -p "$dir/bin"
chmod 700 "$HOME/.masscode" "$dir"
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
supervisor=$(cat "$dir/supervisor.pid" 2>/dev/null || true)
daemon=$(cat "$dir/daemon.pid" 2>/dev/null || true)
if [ "$2" = stop ]; then
  if alive "$supervisor"; then kill "$supervisor"; fi
  if alive "$daemon"; then kill "$daemon"; fi
  exit 0
fi
if [ "$(uname -s)" != Linux ]; then echo "state=unsupported"; echo "os=$(uname -s)"; exit 0; fi
if [ ! -x "$dir/bin/masscode-daemon-$version" ]; then echo "state=missing"; echo "arch=$(uname -m)"; exit 0; fi
if [ ! -s "$dir/token" ]; then (umask 077; od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$dir/token"); fi
ln -sfn "masscode-daemon-$version" "$dir/bin/masscode-daemon"
if alive "$supervisor"; then
  if [ "$(cat "$dir/running" 2>/dev/null || true)" != "masscode-daemon-$version" ]; then
    if [ "$2" != restart ]; then
      if alive "$daemon"; then kill -USR2 "$daemon"; fi
      echo "state=updating"
      exit 0
    fi
    if alive "$daemon"; then kill "$daemon"; fi
  fi
else
  detach=""
  if command -v setsid >/dev/null 2>&1; then detach=setsid; fi
  MASSCODE_REMOTE_DIR="$dir" nohup $detach sh -c '
    dir="$MASSCODE_REMOTE_DIR"
    while :; do
      if [ "$(wc -c < "$dir/daemon.log")" -gt 10000000 ]; then : > "$dir/daemon.log"; fi
      rm -f "$dir/port"
      readlink "$dir/bin/masscode-daemon" > "$dir/running"
      MASSCODE_TOKEN="$(cat "$dir/token")" MASSCODE_PORT=0 MASSCODE_PORT_FILE="$dir/port" MASSCODE_DETACHED=1 "$dir/bin/masscode-daemon" &
      echo $! > "$dir/daemon.pid"
      wait $! || true
      sleep 1
    done' >> "$dir/daemon.log" 2>&1 < /dev/null &
  echo $! > "$dir/supervisor.pid"
fi
tries=0
while [ "$(cat "$dir/running" 2>/dev/null || true)" != "masscode-daemon-$version" ] || [ ! -s "$dir/port" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 150 ]; then
    echo "state=failed"
    tail -n 3 "$dir/daemon.log" | sed 's/^/log=/'
    exit 0
  fi
  sleep 0.2
done
for file in "$dir"/bin/masscode-daemon-*; do
  case "$(basename "$file")" in "masscode-daemon-$version") ;; *) rm -f "$file" ;; esac
done
echo "state=running"
echo "port=$(cat "$dir/port")"
echo "token=$(cat "$dir/token")"
`;

function broadcast() {
  const list = listHosts();
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed()) window.webContents.send("hosts-changed", list);
}

function setStatus(host: Host, status: HostStatus) {
  host.status = status;
  broadcast();
}

/** What went wrong in words that say how to fix it, from ssh's stderr. */
function sshError(alias: string, stderr: string) {
  if (/permission denied/i.test(stderr))
    return `Couldn't sign in to ${alias}. MassCode signs in with your SSH keys or agent, not a password: run ssh-copy-id ${alias} in a terminal, then retry.`;
  if (/host key verification failed/i.test(stderr))
    return `${alias}'s host key isn't trusted yet. Run ssh ${alias} in a terminal once to accept it, then retry.`;
  if (/could not resolve hostname/i.test(stderr))
    return `Couldn't find ${alias}. Check the name, or add it to ~/.ssh/config.`;
  if (/timed out|connection refused|no route to host|network is unreachable/i.test(stderr))
    return `Couldn't reach ${alias}. Check that it's on and reachable from this Mac, then retry.`;
  return stderr.trim().split("\n").at(-1) || `ssh ${alias} failed`;
}

/** One ssh command; `input` goes to its stdin. Rejects with a readable error when ssh itself fails. */
function ssh(alias: string, command: string, input: string | Readable) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTIONS, "-T", alias, command]);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(error));
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(sshError(alias, stderr))),
    );

    if (typeof input === "string") child.stdin.end(input);
    else
      input
        .on("error", (error) => {
          child.kill();
          reject(error);
        })
        .pipe(child.stdin)
        .on("error", () => {});
  });
}

async function runScript(alias: string, version: string, mode: "start" | "restart" | "stop") {
  const lines = (await ssh(alias, `sh -s -- ${version} ${mode}`, REMOTE_SCRIPT))
    .split("\n")
    .filter((line) => line.includes("="));
  const values = new Map(
    lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const log = lines.filter((line) => line.startsWith("log=")).map((line) => line.slice(4));
  return { values, log };
}

function linuxArch(machine: string) {
  if (machine === "x86_64" || machine === "amd64") return "x64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  return null;
}

/** Counts bytes going by, for upload and download progress. */
function progress(total: number, report: (percent: number) => void) {
  let done = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length;
      if (total > 0) report(Math.min(99, Math.floor((done / total) * 100)));
      callback(null, chunk);
    },
  });
}

/**
 * The version hosts should run. In dev it's the Linux build next to this checkout,
 * versioned by when it was built (`pnpm --filter @masscode/daemon build:linux`).
 */
async function wantedVersion() {
  if (app.isPackaged) return app.getVersion();

  const built = await stat(devArchive("x64")).catch(() => stat(devArchive("arm64")));
  return `dev-${Math.round(built.mtimeMs)}`;
}

function devArchive(arch: string) {
  return join(app.getAppPath(), "..", "daemon", "dist", `masscode-daemon-linux-${arch}.gz`);
}

/** The gzipped daemon for `arch`, downloaded from this version's release the first time. */
async function daemonArchive(host: Host, arch: string, version: string) {
  if (!app.isPackaged) return devArchive(arch);

  const path = join(
    app.getPath("userData"),
    "remote",
    `masscode-daemon-${version}-linux-${arch}.gz`,
  );
  if (await stat(path).catch(() => null)) return path;

  const response = await net.fetch(
    `https://github.com/masmeert/code/releases/download/v${version}/masscode-daemon-linux-${arch}.gz`,
  );
  if (!response.ok || !response.body)
    throw new Error(
      `Couldn't download MassCode for ${host.alias} (${response.status} from GitHub). Check this Mac's connection, then retry.`,
    );

  await mkdir(join(path, ".."), { recursive: true });
  await pipeline(
    // SAFETY: Electron's fetch body is a web ReadableStream, which Readable.fromWeb takes.
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    progress(Number(response.headers.get("content-length")), (percent) =>
      setStatus(
        host,
        HostStatus.cases.connecting.make({ step: `Downloading MassCode (${percent}%)` }),
      ),
    ),
    createWriteStream(`${path}.part`),
  );
  await rename(`${path}.part`, path);
  return path;
}

async function upload(host: Host, arch: string, version: string) {
  const archive = await daemonArchive(host, arch, version);
  const { size } = await stat(archive);
  await ssh(
    host.alias,
    `sh -c 'd="$HOME/.masscode/remote/bin"; mkdir -p "$d" && gzip -dc > "$d/.upload" && chmod +x "$d/.upload" && mv "$d/.upload" "$d/masscode-daemon-${version}"'`,
    // Forwards a read error to the progress stream, so ssh sees it and rejects.
    pipeStreams(
      createReadStream(archive),
      progress(size, (percent) =>
        setStatus(
          host,
          HostStatus.cases.connecting.make({ step: `Installing MassCode (${percent}%)` }),
        ),
      ),
      () => {},
    ),
  );
}

function waitForPort(port: number, tunnel: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 15000;

    function attempt() {
      if (tunnel.exitCode !== null) return reject(new Error("The SSH tunnel closed while opening"));

      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error("The SSH tunnel didn't open in time"));
        else setTimeout(attempt, 100);
      });
    }

    attempt();
  });
}

/**
 * Sends a host's browser tabs through its tunnel's SOCKS proxy, loopback included, so
 * `localhost` is the host's. With no tunnel they go nowhere rather than to this Mac.
 */
async function routeBrowser(alias: string, socksPort: number | null) {
  const partition = session.fromPartition(browserPartition(alias));
  configureBrowserSession(partition);
  // ponytail: port 9 (discard) is a dead end on any Mac; a PAC script that refuses would be exact
  await partition.setProxy({
    proxyRules: `socks5://127.0.0.1:${socksPort ?? 9}`,
    proxyBypassRules: "<-loopback>",
  });
}

/** Forwards a local port to the daemon, and a SOCKS proxy for the host's browser tabs. */
async function openTunnel(host: Host, remotePort: number, token: string) {
  const [localPort, socksPort] = [await freePort(), await freePort()];
  let stderr = "";
  const tunnel = spawn("ssh", [
    "-T",
    ...SSH_OPTIONS,
    "-o",
    "ExitOnForwardFailure=yes",
    // A shared connection would outlive this process, and a dead one would take the tunnel along.
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    "-D",
    `127.0.0.1:${socksPort}`,
    host.alias,
    // Instead of -N: `cat` ends when our end of its stdin closes, which it does however this
    // app exits, crashes included, so no tunnel outlives it.
    "cat > /dev/null",
  ]);

  tunnel.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  tunnel.once("exit", () => {
    if (host.tunnel?.process !== tunnel) return;
    host.tunnel = null;
    void routeBrowser(host.alias, null);
    if (hosts.get(host.alias) === host && HostStatus.guards.connected(host.status))
      setStatus(host, HostStatus.cases.connecting.make({ step: "Reconnecting" }));
  });

  try {
    await waitForPort(localPort, tunnel);
  } catch (error) {
    tunnel.kill();
    throw new Error(
      stderr
        ? sshError(host.alias, stderr)
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  await routeBrowser(host.alias, socksPort);
  host.tunnel?.process.kill();
  host.tunnel = { process: tunnel, remotePort, daemon: { port: localPort, token } };
  return host.tunnel.daemon;
}

async function connectHost(host: Host, mode: "start" | "restart"): Promise<Daemon | null> {
  if (!HostStatus.guards.connected(host.status))
    setStatus(host, HostStatus.cases.connecting.make({ step: "Connecting" }));

  try {
    const version = await wantedVersion();
    if (!VERSION_PATTERN.test(version)) throw new Error(`Unexpected app version ${version}`);

    let { values, log } = await runScript(host.alias, version, mode);
    if (values.get("state") === "missing") {
      const arch = linuxArch(values.get("arch") ?? "");
      if (!arch)
        throw new Error(
          `MassCode runs on x64 and arm64 Linux hosts; ${host.alias} is ${values.get("arch")}.`,
        );
      await upload(host, arch, version);
      setStatus(host, HostStatus.cases.connecting.make({ step: "Starting MassCode" }));
      ({ values, log } = await runScript(host.alias, version, mode));
    }

    const state = values.get("state");
    if (state === "unsupported")
      throw new Error(
        `MassCode runs on Linux hosts for now; ${host.alias} runs ${values.get("os")}.`,
      );

    if (state === "updating") {
      setStatus(host, HostStatus.cases.updating.make({}));
      return null;
    }

    const port = Number(values.get("port"));
    const token = values.get("token");
    if (state !== "running" || !port || !token)
      throw new Error(
        `MassCode didn't start on ${host.alias}${log.length ? `: ${log.join(" ")}` : "."}`,
      );

    const daemon =
      host.tunnel?.remotePort === port && host.tunnel.process.exitCode === null
        ? host.tunnel.daemon
        : await openTunnel(host, port, token);

    if (hosts.get(host.alias) !== host) return null;
    setStatus(host, HostStatus.cases.connected.make({}));
    return daemon;
  } catch (error) {
    if (hosts.get(host.alias) === host)
      setStatus(
        host,
        HostStatus.cases.failed.make({
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    return null;
  }
}

function ensureConnected(host: Host, mode: "start" | "restart" = "start") {
  return (host.connecting ??= connectHost(host, mode).finally(() => (host.connecting = null)));
}

async function saveList() {
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(listFile(), JSON.stringify([...hosts.keys()]));
}

export async function loadHosts() {
  const saved: unknown = JSON.parse(await readFile(listFile(), "utf8").catch(() => "[]"));
  if (!Array.isArray(saved)) return;

  for (const alias of saved) {
    if (typeof alias !== "string") continue;
    hosts.set(alias, {
      alias,
      status: HostStatus.cases.connecting.make({ step: "Connecting" }),
      connecting: null,
      tunnel: null,
    });
    await routeBrowser(alias, null);
  }
}

export function listHosts(): ReadonlyArray<RemoteHost> {
  return [...hosts.values()].map(({ alias, status }) => ({ alias, status }));
}

/**
 * The daemon's tunnel end, connecting first if needed. Checked on every reconnect: the
 * host's daemon may have restarted on another port, or updated.
 */
export function hostDaemon(alias: string) {
  const host = hosts.get(alias);
  return host ? ensureConnected(host) : Promise.resolve(null);
}

export async function addHost(alias: string) {
  const trimmed = alias.trim();
  // An alias starting with "-" would reach ssh as an option.
  if (!trimmed || trimmed.startsWith("-") || /\s/.test(trimmed) || hosts.has(trimmed)) return;

  hosts.set(trimmed, {
    alias: trimmed,
    status: HostStatus.cases.connecting.make({ step: "Connecting" }),
    connecting: null,
    tunnel: null,
  });
  await routeBrowser(trimmed, null);
  broadcast();
  await saveList();
}

export async function removeHost(alias: string) {
  const host = hosts.get(alias);
  if (!host) return;

  hosts.delete(alias);
  host.tunnel?.process.kill();
  broadcast();
  await saveList();
  await ssh(alias, "sh -s -- - stop", REMOTE_SCRIPT).catch(() => {});
}

export async function restartHost(alias: string) {
  const host = hosts.get(alias);
  if (!host) return;

  await host.connecting;
  await ensureConnected(host, "restart");
}

export function closeTunnels() {
  for (const host of hosts.values()) host.tunnel?.process.kill();
}

const GIT_FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org", "ssh.dev.azure.com"]);

/** Concrete `Host` names in ~/.ssh/config and the files it includes; patterns like `*.internal` can't be connected to as-is. */
export async function sshAliases() {
  const sshDirectory = join(homedir(), ".ssh");
  const main = await readFile(join(sshDirectory, "config"), "utf8").catch(() => "");
  // ponytail: one level of Include without globs, which covers OrbStack's and most tools'
  const included = await Promise.all(
    [...main.matchAll(/^\s*Include\s+(.+)$/gim)]
      .flatMap((match) => match[1]?.trim().split(/\s+/) ?? [])
      .flatMap((path) =>
        /[*?]/.test(path)
          ? []
          : [
              readFile(
                path.startsWith("~/")
                  ? join(homedir(), path.slice(2))
                  : resolve(sshDirectory, path),
                "utf8",
              ).catch(() => ""),
            ],
      ),
  );

  return [
    ...new Set(
      [main, ...included]
        .flatMap((config) => [...config.matchAll(/^\s*Host\s+(.+)$/gim)])
        .flatMap((match) => match[1]?.trim().split(/\s+/) ?? [])
        // Git forges sit in most configs for pushing over SSH; nothing runs agents there.
        .filter((name) => !/[*?!]/.test(name) && !GIT_FORGES.has(name)),
    ),
  ];
}
