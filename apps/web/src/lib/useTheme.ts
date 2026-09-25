import type { Theme } from "@apcode/contracts";
import { useEffect } from "react";

/**
 * Swaps <html class="dark"> in one frame with all CSS transitions frozen, so every surface flips at once.
 * (A view-transition wipe was tried: it snapshots the page, dropping backdrop blur and letting
 * `transition-colors` elements fade in late.)
 */
const applyDark = (dark: boolean) => {
  const root = document.documentElement;
  if (root.classList.contains("dark") === dark) return;
  root.dataset.themeSwitching = "";
  root.classList.toggle("dark", dark);
  void root.offsetHeight; // commit the new colours while transitions are off
  requestAnimationFrame(() => delete root.dataset.themeSwitching);
};

/** Keeps <html class="dark">, the native window chrome and the pre-paint cache in sync with the setting. */
export const useTheme = (theme: Theme) => {
  useEffect(() => {
    try {
      localStorage.setItem("apcode.theme", theme);
    } catch {}
    void window.desktop?.setTheme(theme).catch(() => {});

    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyDark(theme === "dark" || (theme === "system" && media.matches));
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
};
