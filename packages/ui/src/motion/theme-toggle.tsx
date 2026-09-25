import { Moon, Sun } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, type ComponentPropsWithoutRef } from "react";
import { flushSync } from "react-dom";
import { ActionSwapIcon } from "@apcode/ui/motion/action-swap";
import { EASE_OUT_CSS } from "@apcode/ui/lib/ease";
import { cn } from "@apcode/ui/lib/utils";

export type ThemeVariant = "rectangle" | "circle" | "circle-blur" | "blinds";

export type RectStart =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center"
  | "bottom-up";

export interface ThemeToggleOptions {
  /** Whether the dark theme is showing. */
  dark: boolean;
  /**
   * Switches the theme. Runs inside the view transition and is flushed
   * synchronously, so the new theme has to reach the DOM by the time React
   * commits (a class set in an effect does).
   */
  onDarkChange: (dark: boolean) => void;
  /** Animation variant. Default: "rectangle". */
  variant?: ThemeVariant;
  /** Origin direction for the reveal. Default: "bottom-up". */
  start?: RectStart;
}

export interface ThemeToggleProps
  extends ThemeToggleOptions, Omit<ComponentPropsWithoutRef<"button">, "children" | "onClick"> {
  iconClassName?: string;
}

const VT_STYLE_ID = "theme-toggle-vt";

// View transitions animate in CSS, not motion springs, so easing here is
// either EASE_OUT_CSS or a keyword. The circle variants keep the Material
// standard curve because their reveal expands symmetrically rather than
// decelerating. Durations differ per variant to match native OS mode switches.
const VT_CSS = `
html[data-theme-vt="rect"]::view-transition-old(root) {
  animation: none;
  mix-blend-mode: normal;
}
html[data-theme-vt="rect"]::view-transition-new(root) {
  mix-blend-mode: normal;
  animation: theme-vt-rect-reveal 400ms ease-out;
}
html[data-theme-vt="circle"]::view-transition-old(root),
html[data-theme-vt="circle-blur"]::view-transition-old(root) {
  animation: none;
  mix-blend-mode: normal;
}
html[data-theme-vt="circle"]::view-transition-new(root) {
  mix-blend-mode: normal;
  animation: theme-vt-circle-reveal 700ms cubic-bezier(0.4, 0, 0.2, 1);
}
html[data-theme-vt="circle-blur"]::view-transition-new(root) {
  mix-blend-mode: normal;
  animation: theme-vt-circle-blur-reveal 700ms cubic-bezier(0.4, 0, 0.2, 1);
}
html[data-theme-vt="blinds"]::view-transition-old(root) {
  animation: none;
  mix-blend-mode: normal;
}
/* Slats: a masked band widens inside every 72px tile, so the new theme opens
   across the page like a shutter. The band edge has to be a registered custom
   property — mask-image itself is not animatable, but it re-resolves every
   frame the property ticks. mask-size fixes the tile at 72px rather than
   letting a repeating gradient's last stop define it, which is what keeps the
   20px soft edge from dragging the tile wider than the slat and leaving a
   feathered gap that never closes; it also means both ends land clean, fully
   transparent at -20px and fully opaque at 72px. Falling back to no mask
   (unregistered property, so the var is invalid) reveals the page in one
   step. */
@property --theme-vt-slat {
  syntax: "<length>";
  inherits: false;
  initial-value: 72px;
}
html[data-theme-vt="blinds"]::view-transition-new(root) {
  mix-blend-mode: normal;
  mask-image: linear-gradient(
    90deg,
    #000 0 var(--theme-vt-slat),
    transparent calc(var(--theme-vt-slat) + 20px)
  );
  mask-size: 72px 100%;
  mask-repeat: repeat;
  animation: theme-vt-blinds-reveal 700ms ${EASE_OUT_CSS};
}
@keyframes theme-vt-rect-reveal {
  from { clip-path: var(--theme-vt-from, inset(100% 0 0 0)); }
  to   { clip-path: inset(0 0 0 0); }
}
@keyframes theme-vt-circle-reveal {
  from { clip-path: circle(0% at var(--theme-vt-origin, 50% 100%)); }
  to   { clip-path: circle(150% at var(--theme-vt-origin, 50% 100%)); }
}
@keyframes theme-vt-circle-blur-reveal {
  from { clip-path: circle(0% at var(--theme-vt-origin, 50% 100%)); filter: blur(8px); }
  to   { clip-path: circle(150% at var(--theme-vt-origin, 50% 100%)); filter: blur(0px); }
}
@keyframes theme-vt-blinds-reveal {
  from { --theme-vt-slat: -20px; }
  to   { --theme-vt-slat: 72px; }
}
`;

const RECT_FROM: Record<RectStart, string> = {
  "top-left": "inset(0 100% 100% 0)",
  "top-right": "inset(0 0 100% 100%)",
  "bottom-left": "inset(100% 100% 0 0)",
  "bottom-right": "inset(100% 0 0 100%)",
  center: "inset(50% 50% 50% 50%)",
  "bottom-up": "inset(100% 0 0 0)",
};

const CIRCLE_ORIGIN: Record<RectStart, string> = {
  "top-left": "0% 0%",
  "top-right": "100% 0%",
  "bottom-left": "0% 100%",
  "bottom-right": "100% 100%",
  center: "50% 50%",
  "bottom-up": "50% 100%",
};

export function useThemeToggle({
  dark,
  onDarkChange,
  variant = "rectangle",
  start = "bottom-up",
}: ThemeToggleOptions) {
  const reduce = useReducedMotion() ?? false;
  useEffect(() => {
    if (document.getElementById(VT_STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = VT_STYLE_ID;
    el.textContent = VT_CSS;
    document.head.appendChild(el);
  }, []);

  const toggle = () => {
    const next = !dark;

    if (reduce || !("startViewTransition" in document)) {
      onDarkChange(next);
      return;
    }

    const root = document.documentElement;

    if (variant === "rectangle") {
      root.style.setProperty("--theme-vt-from", RECT_FROM[start]);
      root.dataset.themeVt = "rect";
    } else if (variant === "blinds") {
      // Slats sweep the whole viewport; there is no origin point to set.
      root.dataset.themeVt = "blinds";
    } else {
      root.style.setProperty("--theme-vt-origin", CIRCLE_ORIGIN[start]);
      root.dataset.themeVt = variant;
    }

    const vt = (
      document as Document & {
        startViewTransition(cb: () => void): { finished: Promise<void> };
      }
    ).startViewTransition(() => flushSync(() => onDarkChange(next)));

    vt.finished.finally(() => {
      delete root.dataset.themeVt;
    });
  };

  return { toggle };
}

export function ThemeToggle({
  dark,
  onDarkChange,
  variant = "rectangle",
  start = "bottom-up",
  className,
  iconClassName,
  ...rest
}: ThemeToggleProps) {
  const { toggle } = useThemeToggle({ dark, onDarkChange, variant, start });

  return (
    <button
      type="button"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggle}
      className={cn("flex items-center justify-center", className)}
      {...rest}
    >
      <ActionSwapIcon value={dark ? "dark" : "light"} animation="blur" className={iconClassName}>
        {dark ? <Sun className={iconClassName} /> : <Moon className={iconClassName} />}
      </ActionSwapIcon>
    </button>
  );
}
