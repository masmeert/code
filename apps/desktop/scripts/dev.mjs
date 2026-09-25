import { spawn } from "node:child_process";
import { mkdirSync, watch } from "node:fs";
import electron from "electron";

const build = spawn("pnpm", ["build", "--watch"], { stdio: "inherit" });
let app = null;
let restartTimer = null;

function launch() {
  app = spawn(electron, ["."], { stdio: "inherit" });
  app.on("exit", (code) => process.exit(code ?? 0));
}

function restart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    app?.removeAllListeners("exit");
    app?.kill();
    launch();
  }, 150);
}

process.on("exit", () => {
  build.kill();
  app?.kill();
});
mkdirSync("dist", { recursive: true });
watch("dist", (_event, file) => {
  if (file?.endsWith(".cjs")) restart();
});
