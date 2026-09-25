import { useEffect, useRef } from "react";

export function useArrivalOrder(ids: readonly string[]) {
  const known = useRef<ReadonlySet<string>>(new Set());
  const arrivals = ids.filter((id) => !known.current.has(id));
  useEffect(() => {
    known.current = new Set(ids);
  });
  return (id: string) => Math.max(0, arrivals.indexOf(id));
}
