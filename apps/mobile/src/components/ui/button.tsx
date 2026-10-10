import { cva, type VariantProps } from "class-variance-authority";
import { Pressable } from "react-native";
import { cn } from "@/lib/cn.ts";
import { TextClassContext } from "./text.tsx";

// The desktop's button (packages/ui/src/motion/button/base.tsx): variants and sizes alike.
const buttonVariants = cva("flex-row items-center justify-center", {
  variants: {
    variant: {
      primary: "border border-primary bg-primary active:opacity-85",
      secondary: "border border-border bg-card active:bg-muted",
      ghost: "active:bg-muted/60",
      outline: "border border-border active:bg-muted/60",
      destructive: "bg-destructive/10 active:bg-destructive/20",
    },
    size: {
      sm: "h-8 gap-1.5 rounded-lg px-3",
      md: "h-10 gap-2 rounded-xl px-5",
      lg: "h-12 gap-2 rounded-xl px-6",
      icon: "size-8 rounded-lg",
    },
  },
  defaultVariants: { variant: "primary", size: "md" },
});

const buttonTextVariants = cva("font-sans font-medium", {
  variants: {
    variant: {
      primary: "text-primary-foreground",
      secondary: "text-foreground",
      ghost: "text-muted-foreground",
      outline: "text-foreground",
      destructive: "text-destructive",
    },
    size: {
      sm: "text-xs",
      md: "text-sm",
      lg: "text-base",
      icon: "text-sm",
    },
  },
  defaultVariants: { variant: "primary", size: "md" },
});

type ButtonProps = React.ComponentProps<typeof Pressable> & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        className={cn(props.disabled && "opacity-50", buttonVariants({ variant, size }), className)}
        role="button"
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };

export type { ButtonProps };
