import * as Network from "expo-network";
import { AppState } from "react-native";
import { reconnectAll, useHostStore } from "@/entities/host";
import { forgetHostProjects } from "@/entities/project";
import { forgetHostProviders } from "@/entities/provider";
import { forgetHostThreads } from "@/entities/thread";

// What came over a host's connection goes with the host: when it's forgotten, and when it's turned
// on or off, which replaces its pairing.
useHostStore.subscribe((state, previous) => {
  for (const [hostId, host] of Object.entries(previous.hosts))
    if (state.hosts[hostId]?.paired !== host.paired) {
      forgetHostThreads(hostId);
      forgetHostProjects(hostId);
      forgetHostProviders(hostId);
    }
});

// iOS suspends the app in the background and its sockets die; coming back reconnects at once.
AppState.addEventListener("change", (status) => {
  if (status === "active") reconnectAll();
});

// A new network (Wi-Fi to cellular, Tailscale back on) can reach hosts the old one couldn't.
Network.addNetworkStateListener(({ isConnected }) => {
  if (isConnected) reconnectAll();
});
