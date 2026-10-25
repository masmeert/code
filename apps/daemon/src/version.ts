// The compiled binary inlines this at build time, so a downloaded daemon knows which release it is.
import { version } from "../../../package.json" with { type: "json" };

export const VERSION = version;
