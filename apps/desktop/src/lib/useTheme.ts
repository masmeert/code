import type { Theme } from "@apcode/contracts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { isTauri } from "./platform.ts";

/** Keeps <html class="dark">, the native window chrome and the pre-paint cache in sync with the setting. */
export const useTheme = (theme: Theme) => {
  const mounted = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem("apcode.theme", theme);
    } catch {}
    if (isTauri) void getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => {});

    const root = document.documentElement;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => root.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));

    // Changing the setting reveals the new theme; first paint and OS switches just apply it.
    const animate = mounted.current && "startViewTransition" in document && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    mounted.current = true;
    if (animate) {
      root.dataset.themeReveal = "";
      document
        .startViewTransition(apply)
        .finished.finally(() => delete root.dataset.themeReveal)
        .catch(() => {});
    } else apply();

    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
};
