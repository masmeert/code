import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Port 1420 is allow-listed by the daemon's origin check.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // @pierre/diffs' highlighter worker is an ES module.
  worker: { format: "es" },
});
