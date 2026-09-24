/** True inside the Tauri shell; false in `pnpm dev:web`. */
export const isTauri = "__TAURI_INTERNALS__" in window;
