export { startPhonePairing } from "./api/phone-pairing.ts";

export { buildMachineOptions, THIS_MAC, toMachine } from "./lib/machines.ts";

export {
  getDataId,
  getHostState,
  isHostReady,
  markDisconnected,
  markIncompatible,
  receiveShell,
  setPhoneAccess,
  setPhones,
  setRemoteHosts,
  showCachedData,
  useHostStore,
  useIsHostConnected,
  watchHosts,
} from "./model/host-store.ts";

export {
  allowFullAccessAsRoot,
  forgetFullAccessAsRoot,
  useNeedsRootConsent,
} from "./model/root-consent.ts";
