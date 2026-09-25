import { DEFAULT_DAEMON_PORT } from "@apcode/contracts";

export const PORT = Number(process.env.APCODE_PORT ?? DEFAULT_DAEMON_PORT);
