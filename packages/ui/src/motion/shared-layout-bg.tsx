import {
  type HTMLMotionProps,
  motion,
  PresenceContext,
  useReducedMotion,
} from "motion/react";
import {
  Children,
  cloneElement,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useId,
  useState,
} from "react";
import { EASE_OUT, SPRING_LAYOUT } from "@apcode/ui/lib/ease";
import { cn } from "@apcode/ui/lib/utils";

export interface SharedLayoutBgProps
  extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  children: ReactNode;
  /** Semantic container used for the children. */
  as?: "div" | "ul";
  /** Tailwind class applied to the moving pill. Defaults to a subtle foreground tint. */
  pillClassName?: string;
  /** Horizontal inset of the pill relative to each row (px). Default 20. */
  inset?: number;
  /** Optional positioning override for the pill wrapper inside each item. */
  pillContainerClassName?: string;
}

export const SharedLayoutBg = forwardRef<HTMLElement, SharedLayoutBgProps>(
  function SharedLayoutBg(
    {
      children,
      as = "div",
      className,
      onMouseLeave,
      pillClassName,
      pillContainerClassName,
      inset = 20,
      ...props
    },
    forwardedRef,
  ) {
  const [active, setActive] = useState<{
    id: string;
    session: number;
    fresh: boolean;
    visible: boolean;
  } | null>(null);
  const uid = useId();
  const reduce = useReducedMotion();

    const renderedChildren = Children.toArray(children)
      .filter(isValidElement)
      .map((child, index) => {
        const el = child as ReactElement<{
          className?: string;
          onMouseEnter?: () => void;
          children?: ReactNode;
        }>;
        const childKey = el.key ? String(el.key) : `item-${index}`;
        return cloneElement(
          el,
          {
            key: childKey,
            className: cn("relative", el.props.className),
            onMouseEnter: () => {
              el.props.onMouseEnter?.();
              setActive((current) =>
                current?.visible
                  ? { ...current, id: childKey, fresh: false }
                  : {
                      id: childKey,
                      session: (current?.session ?? 0) + 1,
                      fresh: true,
                      visible: true,
                    },
              );
            },
          },
          <>
            {active?.id === childKey ? (
              <div
                className={cn(
                  "pointer-events-none absolute inset-y-0",
                  pillContainerClassName,
                )}
                style={{ left: -inset, right: -inset }}
              >
                <PresenceContext.Provider value={null}>
                  <motion.div
                    layoutId={`shared-bg-${uid}-${active.session}`}
                    initial={active.fresh ? { opacity: 0 } : false}
                    animate={{ opacity: active.visible ? 1 : 0 }}
                    transition={{
                      opacity: { duration: 0.15, ease: EASE_OUT },
                      layout: reduce ? { duration: 0 } : SPRING_LAYOUT,
                    }}
                    className={cn(
                      "pointer-events-none h-full w-full rounded-2xl bg-muted/80",
                      pillClassName,
                    )}
                  />
                </PresenceContext.Provider>
              </div>
            ) : null}
            <div className="relative z-10">{el.props.children}</div>
          </>,
        );
      });

    const handleMouseLeave = (event: MouseEvent<HTMLElement>) => {
      setActive((current) => current && { ...current, visible: false });
      onMouseLeave?.(event);
    };

    // layoutRoot scopes the pill's layout projection to this list, so fixed or
    // scrolled ancestors can't smear scroll offsets into its movement.
    return as === "ul" ? (
      <motion.ul
        {...(props as HTMLMotionProps<"ul">)}
        ref={forwardedRef as Ref<HTMLUListElement>}
        layoutRoot
        onMouseLeave={handleMouseLeave}
        className={cn("flex w-full flex-col", className)}
      >
        {renderedChildren}
      </motion.ul>
    ) : (
      <motion.div
        {...(props as HTMLMotionProps<"div">)}
        ref={forwardedRef as Ref<HTMLDivElement>}
        layoutRoot
        onMouseLeave={handleMouseLeave}
        className={cn("flex w-full flex-col", className)}
      >
        {renderedChildren}
      </motion.div>
    );
  },
);
