import { type HTMLMotionProps, motion, useReducedMotion } from "motion/react";
import { forwardRef, type ReactNode } from "react";
import { SPRING_PRESS } from "@apcode/ui/lib/ease";
import { cn } from "@apcode/ui/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pressScale?: number;
  children?: ReactNode;
}

export interface ButtonLinkProps extends Omit<HTMLMotionProps<"a">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pressScale?: number;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "sheen bg-primary text-primary-foreground transition-[color,box-shadow,opacity]",
  secondary: "border border-border bg-card text-foreground hover:border-border",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-muted/60",
  outline: "border border-border bg-transparent text-foreground hover:bg-muted/60",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-10 px-5 text-sm gap-2 rounded-xl",
  lg: "h-12 px-6 text-base gap-2 rounded-xl",
  icon: "h-8 w-8 rounded-lg",
};

/**
 * The Button look as a plain class string, for elements that can't be the motion
 * button: Radix `asChild` slots, links rendered by other libraries, calendar days.
 */
export function buttonVariants({
  variant = "primary",
  size = "md",
}: { variant?: ButtonVariant; size?: ButtonSize } = {}) {
  return cn(
    "inline-flex items-center justify-center font-medium select-none",
    "transition-colors",
    "disabled:pointer-events-none disabled:opacity-50",
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    pressScale = size === "icon" ? 0.95 : 0.97,
    className,
    children,
    ...rest
  },
  ref,
) {
  const reduce = useReducedMotion();

  return (
    <motion.button
      ref={ref}
      type="button"
      whileTap={reduce ? undefined : { scale: pressScale }}
      transition={SPRING_PRESS}
      className={cn(
        "inline-flex items-center justify-center font-medium select-none",
        "transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
});

export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  {
    variant = "primary",
    size = "md",
    pressScale = size === "icon" ? 0.95 : 0.97,
    className,
    children,
    ...rest
  },
  ref,
) {
  const reduce = useReducedMotion();

  return (
    <motion.a
      ref={ref}
      whileTap={reduce ? undefined : { scale: pressScale }}
      transition={SPRING_PRESS}
      className={cn(
        "inline-flex items-center justify-center font-medium select-none",
        "transition-colors",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
      {...rest}
    >
      {children}
    </motion.a>
  );
});
