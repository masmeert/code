import type { CSSProperties } from "react";

// The keyframes and the reduced-motion rule travel with the component, so the
// sweep works wherever it is rendered, with or without the package stylesheet.
//
// `!important` because the sweep is an inline style, which outranks a plain rule
// in a media query. It selects a marker class carried by TEXT_SHIMMER_CLASS_NAME
// so it also reaches consumers that build their own span out of these exports.
export const TEXT_SHIMMER_KEYFRAMES =
  "@keyframes text-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}" +
  "@media (prefers-reduced-motion: reduce){.text-shimmer{animation:none !important}}";

export const TEXT_SHIMMER_CLASS_NAME =
  "text-shimmer bg-[length:200%_100%] bg-clip-text text-transparent bg-[linear-gradient(110deg,var(--muted-foreground)_30%,var(--foreground)_50%,var(--muted-foreground)_70%)]";

export function textShimmerStyle(duration: number): CSSProperties {
  return {
    animation: `text-shimmer ${duration}s linear infinite`,
  };
}
