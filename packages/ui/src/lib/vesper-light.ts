import type { ThemeRegistration } from "shiki";
import vesper from "shiki/themes/vesper.mjs";

/**
 * Vesper ships dark only. This keeps every scope and swaps each colour for one that reads on white:
 * the app's light greys, #101010 type, and copper, teal and red for Vesper's peach, mint and red
 * (the same hues as --brand, --success and --destructive in light).
 */
const LIGHT_COLORS = new Map([
  ["#101010", "#fcfcfc"],
  ["#FFF", "#101010"],
  ["#FFFF", "#101010"],
  ["#FFFFFF", "#101010"],
  ["#A0A0A0", "#707070"],
  ["#8B8B8B94", "#a0a0a0"],
  ["#505050", "#a0a0a0"],
  ["#FFC799", "#b66028"],
  ["#FFCFA8", "#b66028"],
  ["#99FFE4", "#11846e"],
  ["#FF8080", "#d33a3c"],
  ["#161616", "#f5f5f5"],
  ["#1C1C1C", "#f5f5f5"],
  ["#232323", "#e8e8e8"],
  ["#282828", "#e8e8e8"],
  ["#343434", "#dbdbdb"],
  ["#FFFFFF25", "#b6602833"],
]);

function toLight(color: string) {
  return LIGHT_COLORS.get(color.toUpperCase()) ?? color;
}

export const vesperLight: ThemeRegistration = {
  ...vesper,
  name: "vesper-light",
  displayName: "Vesper Light",
  type: "light",
  colors: Object.fromEntries(
    Object.entries(vesper.colors ?? {}).map(([key, color]) => [key, toLight(color)]),
  ),
  tokenColors: vesper.tokenColors?.map((rule) =>
    rule.settings?.foreground
      ? { ...rule, settings: { ...rule.settings, foreground: toLight(rule.settings.foreground) } }
      : rule,
  ),
};
