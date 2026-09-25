import type { UpdateStatus } from "@apcode/contracts";
import { useEffect, useState } from "react";

export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!window.desktop) return;
    window.desktop.updateStatus().then(setStatus, () => {});
    return window.desktop.onUpdateStatus(setStatus);
  }, []);
  return status;
}
