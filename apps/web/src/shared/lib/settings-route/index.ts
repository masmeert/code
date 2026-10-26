import { createStore } from "../store";

export type SettingsRoute =
  | "general"
  | "projects"
  | "appearance"
  | "harnesses"
  | "git"
  | "keepAwake"
  | "connections"
  | "phone";

/** Which Settings page is open, if any; any layer can open Settings on a page. */
const settingsRouteStore = createStore<SettingsRoute | null>(null);

export function openSettings(page: SettingsRoute = "general") {
  settingsRouteStore.setState(page);
}

export function closeSettings() {
  settingsRouteStore.setState(null);
}

export function useSettingsRoute() {
  return settingsRouteStore.useStore((page) => page);
}
