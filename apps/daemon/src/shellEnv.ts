import { execFileSync } from "node:child_process";

/**
 * Apps launched from Finder/Dock inherit launchd's bare environment (PATH=/usr/bin:/bin:...),
 * not the one the user's shell builds from ~/.zshrc etc. Ask the login shell once at startup
 * and merge its environment into ours, so every agent, tool call and git command we spawn
 * sees the same node/pnpm/brew/nvm setup as the user's terminal.
 *
 * Imported for its side effect as the daemon's first module, before anything reads process.env.
 */
const MARKER = "__APCODE_SHELL_ENV__";

// Values that describe this process rather than the user's setup; keep ours.
const SKIP = new Set(["_", "PWD", "OLDPWD", "SHLVL", "PPID"]);

const loadShellEnv = (): Record<string, string> | null => {
  if (process.platform === "win32" || process.env.APCODE_SKIP_SHELL_ENV) return null;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    // Markers fence off anything the rc files print; NUL-separated so multi-line values survive.
    const out = execFileSync(
      shell,
      ["-ilc", `printf '${MARKER}'; /usr/bin/env -0; printf '${MARKER}'`],
      {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        // An interactive shell may try to grab the terminal; there is none, so keep it from waiting.
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTARTED: "true" },
      },
    );
    const body = out.split(MARKER)[1];
    if (!body) return null;
    const env: Record<string, string> = {};
    for (const entry of body.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  } catch {
    return null;
  }
};

const shellEnv = loadShellEnv();
if (shellEnv) {
  for (const [key, value] of Object.entries(shellEnv)) {
    // Explicit overrides passed to the daemon (APCODE_*, etc.) win over the shell's.
    if (SKIP.has(key) || (key !== "PATH" && process.env[key] !== undefined)) continue;
    process.env[key] = value;
  }
}
