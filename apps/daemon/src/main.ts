import "./shell-env.ts"; // must stay first: fixes process.env before other modules read it

const args = process.argv.slice(2);

// Bare `masscode` typed on a Linux host shows help rather than starting a second daemon beside
// the service; the app and the service start it without a terminal.
if (args.length > 0 || (process.platform === "linux" && process.stdin.isTTY)) {
  const { runCli } = await import("./cli/cli.ts");
  process.exit(await runCli(args));
}

await import("./daemon.ts");
