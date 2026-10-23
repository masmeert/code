import { isMac } from "@masmeert/ui/lib/keys";

/** Only the macOS desktop window draws traffic lights over the top-left corner. */
export const hasTrafficLights = Boolean(window.desktop) && isMac;
