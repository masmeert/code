import * as React from "react";
import { cn } from "@apcode/ui/lib/utils";
import { EASE_OUT, SPRING_PANEL } from "@apcode/ui/lib/ease";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

const MenuOpenContext = React.createContext(false);

function useMenuOpenState(
  open: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(
    defaultOpen ?? false,
  );
  return [
    open ?? uncontrolledOpen,
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
  ] as const;
}

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

const MORPH_EXIT = { duration: 0.12, ease: EASE_OUT } as const;

function MenuSurface({
  className,
  children,
  ...props
}: React.ComponentProps<typeof motion.div> & {
  "data-side"?: Side;
  "data-align"?: Align;
}) {
  const reduce = useReducedMotion() ?? false;
  const side = props["data-side"] ?? "bottom";
  const align = props["data-align"] ?? "center";
  const crossStart =
    align === "start" ? "0%" : align === "end" ? "92%" : "46%";
  const crossEnd = align === "end" ? "0%" : align === "start" ? "92%" : "46%";
  const top = side === "bottom" ? "0%" : side === "top" ? "92%" : crossStart;
  const bottom = side === "top" ? "0%" : side === "bottom" ? "92%" : crossEnd;
  const left = side === "right" ? "0%" : side === "left" ? "92%" : crossStart;
  const right = side === "left" ? "0%" : side === "right" ? "92%" : crossEnd;
  const hiddenClipPath = `inset(${top} ${right} ${bottom} ${left} round 12px)`;
  const visible = reduce ? { opacity: 1 } : "show";
  return (
    <motion.div
      {...props}
      variants={
        reduce
          ? undefined
          : {
              hidden: { opacity: 0, scale: 0.96, transition: MORPH_EXIT },
              show: { opacity: 1, scale: 1, transition: SPRING_PANEL },
            }
      }
      initial={reduce ? { opacity: 0 } : "hidden"}
      animate={props.style?.animation === "none" ? undefined : visible}
      exit={reduce ? { opacity: 0 } : "hidden"}
      transition={reduce ? { duration: 0.12 } : undefined}
      className="z-50 origin-(--radix-dropdown-menu-content-transform-origin) outline-hidden [filter:drop-shadow(0_1px_1px_rgb(0_0_0/0.06))_drop-shadow(0_8px_20px_rgb(0_0_0/0.12))] data-[state=closed]:pointer-events-none"
    >
      <motion.div
        variants={
          reduce
            ? undefined
            : {
                hidden: { clipPath: hiddenClipPath, transition: MORPH_EXIT },
                show: {
                  clipPath: [hiddenClipPath, "inset(0% 0% 0% 0% round 12px)"],
                  transition: { duration: 0.2, ease: EASE_OUT },
                },
              }
        }
        className={cn(
          "flex min-w-[8rem] flex-col gap-0.5 overflow-hidden rounded-xl border bg-popover p-1.5 text-popover-foreground",
          className,
        )}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

function DropdownMenu({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const [open, setOpen] = useMenuOpenState(openProp, defaultOpen, onOpenChange);
  return (
    <MenuOpenContext.Provider value={open}>
      <DropdownMenuPrimitive.Root
        data-slot="dropdown-menu"
        open={open}
        onOpenChange={setOpen}
        {...props}
      />
    </MenuOpenContext.Provider>
  );
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  );
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
}

function DropdownMenuContent({
  className,
  children,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const open = React.useContext(MenuOpenContext);
  return (
    <AnimatePresence>
      {open ? (
        <DropdownMenuPrimitive.Portal forceMount>
          <DropdownMenuPrimitive.Content
            data-slot="dropdown-menu-content"
            forceMount
            asChild
            sideOffset={sideOffset}
            {...props}
          >
            <MenuSurface
              className={cn(
                "max-h-(--radix-dropdown-menu-content-available-height) overflow-x-hidden overflow-y-auto",
                className,
              )}
            >
              {children}
            </MenuSurface>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      ) : null}
    </AnimatePresence>
  );
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex cursor-default items-center gap-2 h-8 rounded-lg px-2.5 text-[13px] outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 h-8 rounded-lg pr-8 pl-2.5 text-[13px] outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute right-2.5 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 h-8 rounded-lg pr-8 pl-2.5 text-[13px] outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2.5 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-[11px] font-medium text-muted-foreground data-[inset]:pl-8",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1.5 my-1 h-px shrink-0 bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  const [open, setOpen] = useMenuOpenState(openProp, defaultOpen, onOpenChange);
  return (
    <MenuOpenContext.Provider value={open}>
      <DropdownMenuPrimitive.Sub
        data-slot="dropdown-menu-sub"
        open={open}
        onOpenChange={setOpen}
        {...props}
      />
    </MenuOpenContext.Provider>
  );
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-2 h-8 rounded-lg px-2.5 text-[13px] outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[inset]:pl-8 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  children,
  sideOffset = 11,
  alignOffset = -7,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const open = React.useContext(MenuOpenContext);
  return (
    <AnimatePresence>
      {open ? (
        <DropdownMenuPrimitive.Portal forceMount>
          <DropdownMenuPrimitive.SubContent
            data-slot="dropdown-menu-sub-content"
            forceMount
            asChild
            sideOffset={sideOffset}
            alignOffset={alignOffset}
            {...props}
          >
            <MenuSurface className={className}>{children}</MenuSurface>
          </DropdownMenuPrimitive.SubContent>
        </DropdownMenuPrimitive.Portal>
      ) : null}
    </AnimatePresence>
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
