import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./platform.ts";
import { send } from "./store.ts";

/** Asks for a folder and registers it as a project; resolves to its path, or null if cancelled. */
export const addProject = async (): Promise<string | null> => {
  // Browser dev mode has no native dialog.
  const picked = isTauri
    ? await openDialog({ directory: true, multiple: false, title: "Add project folder" })
    : window.prompt("Project folder path");
  const path = typeof picked === "string" ? picked.trim() : "";
  if (!path) return null;
  send({ _tag: "project.add", path });
  return path;
};
