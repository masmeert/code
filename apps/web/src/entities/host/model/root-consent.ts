import { useSyncExternalStore } from "react";
import { useHostStore } from "./host-store.ts";

const listeners = new Set<() => void>();

// A daemon running as root lets Full access change anything on its machine, so each such host
// needs a one-time OK first.
function getRootConsentKey(host: string) {
  return `masscode.fullAccessAsRoot.${host}`;
}

/** Whether Full access on `host` still waits for that OK. */
export function useNeedsRootConsent(host: string | null) {
  const isRoot = useHostStore((state) => host !== null && state.hosts[host]?.root === true);

  const isAllowed = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => host !== null && localStorage.getItem(getRootConsentKey(host)) === "1",
  );

  return isRoot && !isAllowed;
}

export function allowFullAccessAsRoot(host: string) {
  localStorage.setItem(getRootConsentKey(host), "1");

  for (const listener of listeners) listener();
}

export function forgetFullAccessAsRoot(host: string) {
  localStorage.removeItem(getRootConsentKey(host));
}
