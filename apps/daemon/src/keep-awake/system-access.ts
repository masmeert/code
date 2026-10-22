import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../storage/toml-file.ts";
import { readSleepDisabled, runTool, setSleepDisabled } from "./mac-power.ts";

const SUDOERS_PATH = "/etc/sudoers.d/masscode";

const AGENT_LABEL = "com.apkiosk.masscode.keep-awake";

const FOLDER = join(DATA_DIR, "keep-awake");

/** What a session changed, written before each change so a crash can be undone. */
export const JOURNAL_PATH = join(FOLDER, "journal.json");

const RECOVERY_SCRIPT_PATH = join(FOLDER, "recover.sh");

const AGENT_PATH = join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);

/** The only commands the sudoers rule lets this user run as root, without a password. */
const PMSET_ARGUMENTS = [
  "-a disablesleep 0",
  "-a disablesleep 1",
  "-b powermode 0",
  "-b powermode 1",
  "-b powermode 2",
  "-b lowpowermode 0",
  "-b lowpowermode 1",
];

function quoteForShell(text: string) {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Runs every minute while logged in. Once the MassCode that wrote the journal is gone (crashed,
 * force quit, or the Mac restarted), it resumes the apps still paused, unmutes, and gives sleep
 * and the power mode back what they were. The journal stays until that worked, to retry.
 */
const RECOVERY_SCRIPT = `#!/bin/sh
journal=${quoteForShell(JOURNAL_PATH)}
[ -f "$journal" ] || exit 0
read_key() { /usr/bin/plutil -extract "$1" raw -o - "$journal" 2>/dev/null; }
start_time() { /bin/ps -o lstart= -p "$1" 2>/dev/null | /usr/bin/tr -s ' ' | /usr/bin/sed 's/^ //;s/ $//'; }
owner=$(read_key ownerPid)
if [ -n "$owner" ] && [ "$(start_time "$owner")" = "$(read_key ownerStartedAt)" ]; then exit 0; fi
count=$(read_key frozen)
index=0
while [ "$index" -lt "\${count:-0}" ]; do
  pid=$(read_key "frozen.$index.pid")
  if [ -n "$pid" ] && [ "$(start_time "$pid")" = "$(read_key "frozen.$index.startedAt")" ]; then kill -CONT "$pid"; fi
  index=$((index + 1))
done
if [ "$(read_key unmute)" = "true" ]; then /usr/bin/osascript -e 'set volume without output muted'; fi
key=$(read_key powerMode.key)
if [ -n "$key" ]; then /usr/bin/sudo -n /usr/bin/pmset -b "$key" "$(read_key powerMode.value)" || exit 1; fi
before=$(read_key sleepDisabledBefore)
if [ -n "$before" ]; then
  if [ "$before" = "true" ]; then value=1; else value=0; fi
  /usr/bin/sudo -n /usr/bin/pmset -a disablesleep "$value" || exit 1
fi
/bin/rm -f "$journal"
`;

const AGENT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${RECOVERY_SCRIPT_PATH.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;

/** Runs `command` as root behind the system's password prompt; the error says why it didn't. */
function runAsAdministrator(command: string, prompt: string) {
  const script = `do shell script "${command.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" with prompt "${prompt}" with administrator privileges`;

  return new Promise<string | null>((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: 5 * 60_000 },
      (error, _stdout, stderr) =>
        resolve(
          error === null
            ? null
            : stderr.includes("-128")
              ? "You canceled the password prompt. Nothing was changed."
              : `macOS refused: ${stderr.trim() || error.message}`,
        ),
    );
  });
}

async function writeIfChanged(path: string, content: string) {
  const current = await readFile(path, "utf8").catch(() => null);

  if (current === content) return false;

  await writeFile(path, content);

  return true;
}

/** Installs (or updates) the recovery agent; it needs no password, only the sudoers rule to work. */
export async function ensureRecoveryAgent() {
  await mkdir(FOLDER, { recursive: true });
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });

  const changed = [
    await writeIfChanged(RECOVERY_SCRIPT_PATH, RECOVERY_SCRIPT),
    await writeIfChanged(AGENT_PATH, AGENT_PLIST),
  ].some(Boolean);

  const domain = `gui/${process.getuid?.() ?? 501}`;

  const isLoaded =
    (await runTool("/bin/launchctl", ["print", `${domain}/${AGENT_LABEL}`])) !== null;

  if (isLoaded && !changed) return;

  if (isLoaded) await runTool("/bin/launchctl", ["bootout", `${domain}/${AGENT_LABEL}`]);
  await runTool("/bin/launchctl", ["bootstrap", domain, AGENT_PATH]);
}

/** The sudoers rule is in place and lets this user change sleep without a password. */
export async function hasSystemAccess() {
  if (!existsSync(SUDOERS_PATH)) return false;

  const isDisabled = await readSleepDisabled();

  // Setting sleep to what it already is shows the rule works without changing anything.
  return isDisabled !== null && (await setSleepDisabled(isDisabled));
}

/** Asks for the administrator password and installs the sudoers rule and recovery agent; the error says why not. */
export async function installSystemAccess() {
  const user = userInfo().username;

  if (!/^[A-Za-z0-9._-]+$/.test(user))
    return `Your account name "${user}" can't go in a sudoers rule. Set up lid-closed access by hand.`;

  const rule = `${user} ALL=(root) NOPASSWD: ${PMSET_ARGUMENTS.map((argument) => `/usr/bin/pmset ${argument}`).join(", ")}`;

  const error = await runAsAdministrator(
    [
      "tmp=$(/usr/bin/mktemp /tmp/masscode-sudoers.XXXXXX)",
      `echo '${rule}' > "$tmp"`,
      `/usr/sbin/visudo -cf "$tmp" > /dev/null`,
      `/usr/sbin/chown root:wheel "$tmp"`,
      `/bin/chmod 0440 "$tmp"`,
      `/bin/mv "$tmp" ${SUDOERS_PATH}`,
    ].join(" && "),
    "MassCode needs your password once to keep this Mac awake with the lid closed.",
  );

  if (error) return error;

  await ensureRecoveryAgent();

  return (await hasSystemAccess())
    ? null
    : "The sudoers rule was installed but doesn't work. Check /etc/sudoers.d/masscode.";
}

/** Removes the sudoers rule (asking for the password) and the recovery agent. */
export async function removeSystemAccess() {
  const error = await runAsAdministrator(
    `/bin/rm -f ${SUDOERS_PATH}`,
    "MassCode needs your password to remove its permission to keep this Mac awake.",
  );

  if (error) return error;

  await runTool("/bin/launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${AGENT_LABEL}`]);
  await rm(AGENT_PATH, { force: true });
  await rm(RECOVERY_SCRIPT_PATH, { force: true });

  return null;
}
