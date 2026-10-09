import type { ProjectConfig } from "@masscode/contracts";
import { useEffect, useState } from "react";
import { readProjectConfig } from "./store.ts";

/** The project's `masscode.toml`, read again whenever `refreshKey` changes; null until it arrives. */
export function useProjectConfig(
  host: string | null,
  path: string | null | undefined,
  refreshKey = 0,
) {
  const [answer, setAnswer] = useState<{
    path: string;
    config: ProjectConfig;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!path) return;
    let isCancelled = false;
    void readProjectConfig(host, path).then((frame) => {
      if (!isCancelled && frame) setAnswer({ path, config: frame.config, error: frame.error });
    });
    return () => {
      isCancelled = true;
    };
  }, [host, path, refreshKey]);

  return answer?.path === path ? answer : null;
}
