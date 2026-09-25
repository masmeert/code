import { execFileSync } from "node:child_process";

const cache = new Map<string, string>();

/**
 * Finds a CLI on the user's PATH. Apps launched from Finder get a minimal PATH,
 * so fall back to asking the user's login shell.
 */
export const resolveExecutable = (name: string, envOverride: string): string => {
  const override = process.env[envOverride];
  if (override) return override;
  const cached = cache.get(name);
  if (cached) return cached;

  const attempts: Array<[string, Array<string>]> = [
    ["/usr/bin/which", [name]],
    [process.env.SHELL ?? "/bin/zsh", ["-ilc", `command -v ${name}`]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const found = execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 })
        .trim()
        .split("\n")
        .at(-1);
      if (found && found.startsWith("/")) {
        cache.set(name, found);
        return found;
      }
    } catch {
      // try next strategy
    }
  }
  throw new Error(`Could not find \`${name}\` on PATH. Install it or set ${envOverride}.`);
};
