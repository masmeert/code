import { ClientCommand } from "@apcode/contracts";
import { getSettings, send } from "./store.ts";

/** Asks for a folder and registers it as a project; resolves to its path, or null if cancelled. */
export const addProject = async (): Promise<string | null> => {
  // Browser dev mode has no native dialog.
  const picked = window.desktop
    ? await window.desktop.pickFolder("Add project folder", getSettings().addProjectFolder)
    : window.prompt("Project folder path");
  const path = typeof picked === "string" ? picked.trim() : "";
  if (!path) return null;
  send(ClientCommand.cases["project.add"].make({ path }));
  return path;
};
