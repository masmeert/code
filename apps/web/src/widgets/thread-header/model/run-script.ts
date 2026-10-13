import type { ProjectScript } from "@masscode/contracts";
import { normalizeUrl, openPreview } from "@/entities/browser";
import { createTerminal, findScriptTerminal, showTerminal } from "@/entities/terminal";

/** Runs a project script in a terminal of its own, or shows the one it's already running in. */
export function runScript(threadId: string, script: ProjectScript) {
  const running = findScriptTerminal(threadId, script.name);

  if (running) showTerminal(threadId, running);
  else createTerminal(threadId, script);

  const preview = script.preview_url && normalizeUrl(script.preview_url);

  if (preview && window.desktop) openPreview(threadId, preview);
}
