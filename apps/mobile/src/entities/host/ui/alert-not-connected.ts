import { Alert } from "react-native";
import { CONNECTION_HELP } from "../config/connection-labels.ts";
import { useHostStore } from "../model/host-store.ts";

/** Says nothing went to the host, for an action tapped as its connection dropped. */
export function alertNotConnected(hostId: string) {
  const host = useHostStore.getState().hosts[hostId];

  Alert.alert(
    `Not connected to ${host?.paired.name ?? "the computer"}`,
    `Nothing was sent. ${(host && CONNECTION_HELP[host.connection]) ?? "Wait for it to reconnect, then try again."}`,
  );
}
