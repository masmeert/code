import { DEFAULT_DAEMON_PORT } from "@apcode/contracts";

export let PORT = Number(process.env.APCODE_PORT ?? DEFAULT_DAEMON_PORT);

export function setPort(port: number) {
  PORT = port;
}
