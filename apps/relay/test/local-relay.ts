import { spawn } from "node:child_process";

/**
 * Runs this relay under `wrangler dev` on a free port. Wrangler's programmatic API crashes its
 * runtime under Bun, so tests drive the CLI, which runs on Node.
 */
export async function startLocalRelay() {
  const port = 20_000 + Math.floor(Math.random() * 20_000);

  const wrangler = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--persist-to",
      `/tmp/masscode-relay-test-${port}`,
    ],
    { cwd: `${import.meta.dir}/..`, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  let output = "";

  await new Promise<void>((resolve, reject) => {
    function read(chunk: Buffer) {
      output += chunk.toString();

      if (output.includes("Ready on")) resolve();
    }

    wrangler.stdout.on("data", read);
    wrangler.stderr.on("data", read);
    wrangler.on("exit", () => reject(new Error(`wrangler dev exited:\n${output}`)));
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    stop() {
      // SAFETY: `detached` gives wrangler its own process group, so this ends workerd too.
      process.kill(-wrangler.pid!, "SIGTERM");
    },
  };
}
