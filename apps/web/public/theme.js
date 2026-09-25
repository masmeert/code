// Apply the cached theme before first paint to avoid a flash.
try {
  const theme = localStorage.getItem("apcode.theme") ?? "system";
  const dark =
    theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
} catch {}
