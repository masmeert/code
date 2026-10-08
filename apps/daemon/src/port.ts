import { DEFAULT_DAEMON_PORT } from "@masscode/contracts";

export let PORT = Number(process.env.MASSCODE_PORT ?? DEFAULT_DAEMON_PORT);

export function setPort(port: number) {
  PORT = port;
}
