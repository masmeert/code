export { CONNECTION_HELP, CONNECTION_STATUS } from "./config/connection-labels.ts";

export {
  addHost,
  applyConnectionLoss,
  applyHostEvent,
  applyHostShell,
  type HostState,
  markHostOutdated,
  reconnectAll,
  reconnectHost,
  removeHost,
  setHostEnabled,
  useHostStore,
  useIsHostConnected,
} from "./model/host-store.ts";

export { alertNotConnected } from "./ui/alert-not-connected.ts";

export type { PairedHost } from "./model/paired-host.ts";
