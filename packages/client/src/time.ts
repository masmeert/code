import { useEffect, useState } from "react";

/** Compact age like the sidebar shows it: "now", "21m", "3h", "2d", "5w". */
export function formatAge(ms: number, now: number) {
  const minutes = Math.floor((now - ms) / 60_000);

  if (minutes < 1) return "now";

  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);

  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/** Current time, re-read every `everyMs` so relative labels stay fresh. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);

    return () => clearInterval(timer);
  }, [everyMs]);

  return now;
}

/** Time left, like "1 h 20 min" or "45 min". */
export function formatTimeLeft(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);

  if (hours === 0) return `${minutes} min`;

  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** A time of day, like "18:40" or "6:40 PM" as the system writes it. */
export function formatClockTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
