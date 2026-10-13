import { isMac } from "@masscode/ui/lib/keys";

/** Only the macOS desktop window draws traffic lights over the top-left corner. */
export const hasTrafficLights = Boolean(window.desktop) && isMac;
