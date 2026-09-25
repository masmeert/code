import { useEffect, useState } from "react";

/** Compact age like the sidebar shows it: "now", "21m", "3h", "2d", "5w". */
export const ago = (ms: number, now: number) => {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
};

/** Current time, re-read every `everyMs` so relative labels stay fresh. */
export const useNow = (everyMs = 30_000) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
};
