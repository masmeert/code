import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  FileText,
  ImageIcon,
  Paperclip,
  Plus,
  Search,
  Square,
  Star,
  X,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ButtonHTMLAttributes,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@apcode/ui/motion/button";
import { Fold } from "@apcode/ui/motion/fold";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverMenu,
  MorphPopoverTrigger,
} from "@apcode/ui/motion/popover-morph";
import { Switch } from "@apcode/ui/motion/switch";
import { SPRING_SWAP } from "@apcode/ui/lib/ease";
import { formatBinding, matches } from "@apcode/ui/lib/keys";
import { cn } from "@apcode/ui/lib/utils";

/** One row in a composer picker (model, effort, permissions, branch…). */
export interface PromptOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Shown after the label in the menu only, not on the trigger. */
  badge?: ReactNode;
  disabled?: boolean;
  /** Consecutive options sharing a group render under one section header. */
  group?: string;
  groupIcon?: ReactNode;
}

export interface PromptAction {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptAttachment {
  id: string;
  name: string;
  /** Thumbnail URL. */
  preview?: string;
  /** Without a preview, picks the image icon over the document one. */
  image?: boolean;
}

export interface PromptInputProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange" | "onSubmit" | "children"
> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  actions?: PromptAction[];
  onAction?: (action: string) => void;
  /** `alternate` is set when sent with ⌘/Ctrl+Enter, for the opposite of the usual follow-up behavior. */
  onSubmit?: (value: string, how: { alternate: boolean }) => void | Promise<void>;
  /** Blocks sending only; typing and the pickers stay usable. */
  submitDisabled?: boolean;
  /** Something to send besides the text and attachments (e.g. review comments), so an empty prompt can go. */
  pendingContent?: boolean;
  loading?: boolean;
  onStop?: () => void;
  minRows?: number;
  maxRows?: number;
  leadingAction?: ReactNode;
  /** Toolbar items just before attach and send. */
  trailingAction?: ReactNode;
  /** Pickers at the start of the toolbar. */
  controls?: ReactNode[];
  attachments?: PromptAttachment[];
  /** Shows the paperclip button. */
  onAttach?: () => void;
  onRemoveAttachment?: (id: string) => void;
  /** Files pasted into the textarea. */
  onPasteFiles?: (files: File[]) => void;
  /**
   * Text pasted into the textarea; return true to take it over (it isn't inserted).
   * `plain` is set for ⌘⇧V / Ctrl+Shift+V, which asks to keep a paste as text.
   */
  onPasteText?: (text: string, plain: boolean) => boolean;
  /** Above the card, for `PromptInputTray`s. */
  header?: ReactNode;
  /** Strip tucked under the card; children lay out left-to-right, spread apart. */
  footer?: ReactNode;
  className?: string;
}

export function PromptInput({
  value,
  defaultValue = "",
  onValueChange,
  actions = [],
  onAction,
  onSubmit,
  submitDisabled = false,
  pendingContent = false,
  loading = false,
  onStop,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  trailingAction,
  controls = [],
  attachments = [],
  onAttach,
  onRemoveAttachment,
  onPasteFiles,
  onPasteText,
  header,
  footer,
  className,
  disabled,
  placeholder = "Ask the agent to do something…",
  "aria-label": ariaLabel = "Prompt",
  onKeyDown,
  ...textareaProps
}: PromptInputProps) {
  const reduce = useReducedMotion() ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [actionsOpen, setActionsOpen] = useState(false);
  const currentValue = value ?? internalValue;
  const hasContent = Boolean(currentValue.trim()) || attachments.length > 0 || pendingContent;
  // While the agent works, a message can still go (queued or steering); the button stops it only when there's nothing to send.
  const canSubmit = hasContent && !disabled && !submitDisabled;
  const showStop = loading && !hasContent;
  const plainPaste = useRef(false);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    const measurement = measurementRef.current;
    if (!textarea || !measurement || textarea.value !== currentValue) return;

    const lineHeight = 24;
    const nextHeight = Math.min(
      Math.max(measurement.scrollHeight, minRows * lineHeight),
      maxRows * lineHeight,
    );
    const height = `${nextHeight}px`;
    if (textarea.style.height !== height) textarea.style.height = height;
  }, [currentValue, maxRows, minRows]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeTextarea);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  const setValue = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  };

  const submit = (event?: FormEvent, alternate = false) => {
    event?.preventDefault();
    if (!canSubmit) return;

    onSubmit?.(currentValue.trim(), { alternate });
    if (value === undefined) setInternalValue("");
    textareaRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v")
      plainPaste.current = true;
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit(undefined, event.metaKey || event.ctrlKey);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const plain = plainPaste.current;
    plainPaste.current = false;
    const files = [...event.clipboardData.files];
    if (files.length && onPasteFiles) {
      event.preventDefault();
      onPasteFiles(files);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text && onPasteText?.(text, plain)) event.preventDefault();
  };

  return (
    <div className={cn("w-full", className)}>
      {header}
      <form
        onSubmit={submit}
        className={cn(
          "@container relative z-10 w-full rounded-2xl border border-border bg-card p-1.5",
          disabled && "*:opacity-60",
        )}
      >
        <div className="relative rounded-xl border border-border bg-background p-2">
          <div
            ref={measurementRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute inset-x-2 top-0 px-2 text-sm leading-6 [overflow-wrap:break-word] whitespace-pre-wrap"
          >
            {`${currentValue}\u200b`}
          </div>
          <textarea
            ref={textareaRef}
            value={currentValue}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={ariaLabel}
            rows={minRows}
            {...textareaProps}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="scrollbar-hide block w-full resize-none overflow-y-auto bg-transparent px-2 pt-1.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/55"
          />

          <AnimatePresence initial={false}>
            {attachments.length ? (
              <motion.div
                initial={reduce ? { opacity: 1 } : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={reduce ? { duration: 0 } : SPRING_SWAP}
                className="overflow-hidden"
              >
                <div className="flex flex-wrap gap-1.5 px-1 pt-2">
                  {attachments.map((attachment) => (
                    <AttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      onRemove={onRemoveAttachment}
                    />
                  ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="flex min-h-8 items-center gap-1.5 px-0.5 pt-1.5">
          {actions.length ? (
            <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
              <MorphPopoverTrigger>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled || loading}
                  aria-label="Add to prompt"
                  className="size-8 rounded-full border border-border bg-background"
                >
                  <motion.span
                    aria-hidden="true"
                    animate={{ rotate: actionsOpen ? 45 : 0 }}
                    transition={reduce ? { duration: 0 } : SPRING_SWAP}
                  >
                    <Plus className="size-4" />
                  </motion.span>
                </Button>
              </MorphPopoverTrigger>

              <MorphPopoverContent
                side="top"
                align="start"
                sideOffset={8}
                radius={12}
                className="w-56 p-1.5"
              >
                <MorphPopoverMenu>
                  {actions.map((action) => (
                    <button
                      key={action.value}
                      type="button"
                      disabled={action.disabled}
                      onClick={() => {
                        onAction?.(action.value);
                        setActionsOpen(false);
                      }}
                      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
                    >
                      {action.icon ? (
                        <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                          {action.icon}
                        </span>
                      ) : null}
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{action.label}</span>
                        {action.description ? (
                          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                            {action.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </MorphPopoverMenu>
              </MorphPopoverContent>
            </MorphPopover>
          ) : null}
          {leadingAction}
          <div className="flex min-w-0 items-center gap-1.5">{controls}</div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {trailingAction}
            {onAttach ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label="Attach files"
                onClick={onAttach}
                className="size-8 rounded-full border border-border bg-background"
              >
                <Paperclip className="size-4" />
              </Button>
            ) : null}
            <Button
              type={showStop ? "button" : "submit"}
              size="icon"
              disabled={showStop ? !onStop : !canSubmit}
              aria-label={
                showStop
                  ? "Stop generating"
                  : loading
                    ? "Send when the agent is done"
                    : "Send prompt"
              }
              onClick={showStop ? onStop : undefined}
              className="size-8 rounded-full"
            >
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={showStop ? "stop" : "send"}
                  initial={
                    reduce
                      ? { opacity: 1 }
                      : { opacity: 0, transform: "scale(0.95)", filter: "blur(2px)" }
                  }
                  animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
                  exit={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, transform: "scale(0.95)", filter: "blur(2px)" }
                  }
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                  className="grid place-items-center"
                >
                  {showStop ? (
                    <Square className="size-3 fill-current" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </motion.span>
              </AnimatePresence>
            </Button>
          </div>
        </div>
      </form>

      {footer ? (
        <div className="mx-3 -mt-4 flex h-12 items-center justify-between gap-3 rounded-b-xl border border-t-0 border-border bg-background px-1.5 pt-4 text-xs text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A card above the composer (queued messages, running subagents) that folds in and out.
 * Tucked behind the composer's top edge, or `detached` to stand on its own above it.
 */
export function PromptInputTray({
  open,
  detached = false,
  children,
}: {
  open: boolean;
  detached?: boolean;
  children: ReactNode;
}) {
  return (
    <Fold open={open}>
      <div
        className={cn(
          "relative mx-3 max-h-80 overflow-y-auto overscroll-contain border border-border bg-background px-1.5 text-xs text-muted-foreground",
          detached ? "mb-2 rounded-xl py-1" : "-mb-4 rounded-t-xl border-b-0 pt-1 pb-5",
        )}
      >
        {children}
      </div>
    </Fold>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PromptAttachment;
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="group flex h-8 max-w-52 items-center gap-2 rounded-lg border border-border bg-background pr-1 pl-1 text-xs text-foreground">
      {attachment.preview ? (
        <img src={attachment.preview} alt="" className="size-6 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {attachment.image ? (
            <ImageIcon className="size-3.5" />
          ) : (
            <FileText className="size-3.5" />
          )}
        </span>
      )}
      <span className="min-w-0 truncate">{attachment.name}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${attachment.name}`}
          onClick={() => onRemove(attachment.id)}
          className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/** Opens a picker from its keyboard shortcut, or whenever `openSignal` changes. */
function usePickerOpener(
  open: () => void,
  { shortcut, disabled, openSignal }: { shortcut?: string; disabled: boolean; openSignal?: number },
) {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!shortcut || disabled) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !matches(event, shortcut)) return;
      event.preventDefault();
      openRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut, disabled]);
  useEffect(() => {
    if (openSignal) openRef.current();
  }, [openSignal]);
}

/**
 * The compact footer button every composer picker opens from. MorphPopoverTrigger
 * clones in its ref, click handler and aria props, so those pass through to the button.
 */
function PickerTrigger({
  open,
  disabled,
  icon,
  variant = "pill",
  // In a narrow composer an icon reads better than a label truncated to a letter or two.
  compact = Boolean(icon) && variant === "pill",
  className,
  children,
  ...rest
}: {
  open: boolean;
  disabled: boolean;
  icon?: ReactNode;
  variant?: PickerVariant;
  /** Shrinks to the icon in a narrow composer. */
  compact?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      title={typeof children === "string" ? children : undefined}
      {...rest}
      type="button"
      disabled={disabled}
      className={cn(
        "flex max-w-56 min-w-0 items-center gap-1.5 text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        variant === "pill" && "h-8 rounded-full border border-border bg-background px-3 text-xs",
        variant === "plain" && "h-6 rounded-lg px-2 text-[11px]",
        compact && "@max-md:w-8 @max-md:shrink-0 @max-md:justify-center @max-md:px-0",
        open && "bg-muted text-foreground",
        className,
      )}
    >
      {icon ? (
        <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5">{icon}</span>
      ) : null}
      <span className={cn("truncate", compact && "@max-md:sr-only")}>{children}</span>
      <ChevronDown className={cn("size-3 shrink-0 opacity-60", compact && "@max-md:hidden")} />
    </button>
  );
}

type PickerVariant = "pill" | "plain";

export interface PromptSelectProps {
  options: PromptOption[];
  value: string | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: ReactNode;
  /** Trigger icon; defaults to the selected option's (group) icon when `showOptionIcon`. */
  icon?: ReactNode;
  showOptionIcon?: boolean;
  /** Menu title above the options. */
  title?: ReactNode;
  /** Shown instead of options when there are none. */
  empty?: ReactNode;
  /** Shown under the options (e.g. an error). */
  note?: ReactNode;
  /** Adds a filter field once the list is this long. */
  searchThreshold?: number;
  searchPlaceholder?: string;
  /** Offers to create what's typed in the filter when nothing matches it exactly. */
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
  width?: string;
  onOpenChange?: (open: boolean) => void;
  /** Opens the menu from the keyboard, as a binding like `mod+shift+e`. */
  shortcut?: string;
  /** Opens the menu whenever this number changes (for callers with their own trigger logic). */
  openSignal?: number;
  /** Values picked alongside `value` (multi-select by shift-click). */
  multi?: string[];
  /** While open, ⌘1–⌘9 pick the first nine options, each row showing its shortcut. */
  numbered?: boolean;
  /** `plain` for a quiet trigger outside the toolbar, like the strip under the card. */
  variant?: PickerVariant;
  /** Shift-click on an option; without it, shift-click picks like a click. */
  onToggle?: (value: string) => void;
  className?: string;
}

/** Compact picker: small rows, optional sections and descriptions, a check on the current value. */
export function PromptSelect({
  options,
  value,
  onChange,
  disabled = false,
  placeholder = "Choose",
  icon,
  showOptionIcon = false,
  title,
  empty,
  note,
  searchThreshold,
  searchPlaceholder,
  onCreate,
  createLabel,
  side = "top",
  align = "start",
  width = "w-56",
  onOpenChange,
  shortcut,
  openSignal,
  multi = [],
  onToggle,
  numbered = false,
  variant,
  className,
}: PromptSelectProps) {
  const [open, setOpenState] = useState(false);
  const [instant, setInstant] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    setInstant(false);
    onOpenChange?.(next);
  };
  usePickerOpener(
    () => {
      setOpen(true);
      setInstant(true);
    },
    { shortcut, disabled, openSignal },
  );
  const current = options.find((option) => option.value === value);
  const triggerIcon = icon ?? (showOptionIcon ? (current?.groupIcon ?? current?.icon) : undefined);

  return (
    <MorphPopover open={open} onOpenChange={setOpen} className="min-w-0">
      <MorphPopoverTrigger>
        <PickerTrigger
          open={open}
          disabled={disabled}
          icon={triggerIcon}
          variant={variant}
          className={className}
        >
          {multi.length ? `${multi.length + 1} models` : (current?.label ?? placeholder)}
        </PickerTrigger>
      </MorphPopoverTrigger>
      <MorphPopoverContent
        side={side}
        align={align}
        sideOffset={6}
        radius={12}
        instant={instant}
        className={cn(width, "p-1")}
      >
        <OptionList
          options={options}
          value={value}
          onChange={onChange}
          onClose={() => setOpen(false)}
          title={title}
          empty={empty}
          note={note}
          searchThreshold={searchThreshold}
          searchPlaceholder={searchPlaceholder}
          onCreate={onCreate}
          createLabel={createLabel}
          multi={multi}
          onToggle={onToggle}
          numbered={numbered}
        />
      </MorphPopoverContent>
    </MorphPopover>
  );
}

/** A picker's options, as listed in its menu or flyout. Mounted only while that's open. */
function OptionList({
  options,
  value,
  onChange,
  onClose,
  title,
  empty,
  note,
  searchThreshold = 10,
  searchPlaceholder = "Filter…",
  onCreate,
  createLabel = (query) => `Create "${query}"`,
  multi = [],
  onToggle,
  numbered = false,
  focusSelected = false,
  favorites,
  onToggleFavorite,
}: Pick<
  PromptSelectProps,
  | "options"
  | "value"
  | "onChange"
  | "title"
  | "empty"
  | "note"
  | "searchThreshold"
  | "searchPlaceholder"
  | "onCreate"
  | "createLabel"
  | "multi"
  | "onToggle"
  | "numbered"
> & {
  onClose: () => void;
  /** Focuses the current option on open (when there's no filter field to focus), for arrow keys. */
  focusSelected?: boolean;
  /** Starred values; with `onToggleFavorite`, each row gets a star. */
  favorites?: string[];
  onToggleFavorite?: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchable = Boolean(onCreate) || options.length >= searchThreshold;
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const visible = needle
    ? options.filter((option) =>
        [option.value, option.label, option.description].some(
          (text) => typeof text === "string" && text.toLowerCase().includes(needle),
        ),
      )
    : options;
  const canCreate =
    Boolean(onCreate && trimmed) && !options.some((option) => option.value === trimmed);
  const numberedValues = numbered
    ? visible
        .filter((option) => !option.disabled)
        .slice(0, 9)
        .map((option) => option.value)
    : [];

  const pick = (picked: string) => {
    onChange(picked);
    onClose();
  };

  // Resubscribes every render, so the handler always sees the current filter and onChange.
  useEffect(() => {
    if (!numberedValues.length) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const picked = numberedValues[Number(event.key) - 1];
      if (!picked || !matches(event, `mod+${event.key}`)) return;
      event.preventDefault();
      pick(picked);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const create = () => {
    onCreate?.(trimmed);
    onClose();
  };

  // The panel mounts in a portal and morphs in, so `autoFocus` fires too early.
  useEffect(() => {
    if (!searchable && !focusSelected) return;
    const frame = requestAnimationFrame(() =>
      (
        searchRef.current ??
        listRef.current?.querySelector<HTMLElement>(
          '[aria-selected="true"], [role="option"]:not(:disabled)',
        )
      )?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [searchable, focusSelected]);

  return (
    <>
      {title ? (
        <div className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">{title}</div>
      ) : null}
      {searchable ? (
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            // An exact match wins; otherwise create, else take the first match.
            const exact = visible.find((option) => option.value === trimmed && !option.disabled);
            const first = visible.find((option) => !option.disabled);
            if (exact) pick(exact.value);
            else if (canCreate) create();
            else if (first) pick(first.value);
          }}
          placeholder={searchPlaceholder}
          className="mb-1 h-7 w-full rounded-md bg-muted px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
        />
      ) : null}
      <div
        ref={listRef}
        role="listbox"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const rows = [
            ...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)'),
          ];
          const at = rows.findIndex((row) => row === document.activeElement);
          const step = event.key === "ArrowDown" ? 1 : -1;
          rows[(at + step + rows.length) % rows.length]?.focus();
        }}
        className="scrollbar-hide flex max-h-80 flex-col gap-0.5 overflow-y-auto overscroll-contain"
      >
        {visible.length === 0 && !canCreate ? (
          <div className="px-2 py-1.5 text-[13px] text-muted-foreground">
            {needle ? "No matches" : (empty ?? "Nothing here")}
          </div>
        ) : null}
        {canCreate ? (
          <button
            type="button"
            onClick={create}
            className="flex h-7 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground transition-colors outline-none hover:bg-muted focus-visible:bg-muted"
          >
            <CirclePlus className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{createLabel(trimmed)}</span>
          </button>
        ) : null}
        {canCreate && visible.length ? (
          <div aria-hidden="true" className="mx-2 my-0.5 h-px shrink-0 bg-border" />
        ) : null}
        {visible.map((option, index) => {
          const selected = option.value === value || multi.includes(option.value);
          const header = option.group && option.group !== visible[index - 1]?.group;
          const favorite = favorites?.includes(option.value) ?? false;
          return (
            <div key={option.value} className="group/row relative">
              {header && index > 0 ? (
                <div aria-hidden="true" className="mx-2 my-1 h-px bg-border" />
              ) : null}
              {header ? (
                <div className="flex items-center gap-1.5 px-2 pt-1 pb-1 text-[11px] text-muted-foreground">
                  {option.groupIcon ? (
                    <span className="grid size-3 place-items-center [&_svg]:size-3">
                      {option.groupIcon}
                    </span>
                  ) : null}
                  {option.group}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                onClick={(event) => {
                  // Shift-click adds or removes the option and keeps the menu open.
                  if (event.shiftKey && onToggle) {
                    onToggle(option.value);
                    return;
                  }
                  pick(option.value);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50",
                  option.description ? "py-1.5" : "h-7",
                  selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.icon ? (
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center [&_svg]:size-3.5",
                      option.description && "self-start",
                    )}
                    style={option.description ? { marginTop: 2 } : undefined}
                  >
                    {option.icon}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{option.label}</span>
                    {option.badge ? (
                      <span className="grid shrink-0 place-items-center [&_svg]:size-3">
                        {option.badge}
                      </span>
                    ) : null}
                  </span>
                  {option.description ? (
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {numberedValues.includes(option.value) ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
                    {formatBinding(`mod+${numberedValues.indexOf(option.value) + 1}`)}
                  </span>
                ) : null}
                {onToggleFavorite ? (
                  <>
                    {/* Room for the star, which sits over the row as its own button. */}
                    <span aria-hidden="true" className="w-5 shrink-0" />
                    <Check className={cn("size-3.5 shrink-0", !selected && "invisible")} />
                  </>
                ) : selected ? (
                  <Check className="size-3.5 shrink-0" />
                ) : null}
              </button>
              {onToggleFavorite ? (
                // A sibling of the row, not inside it: a button can't hold another.
                <button
                  type="button"
                  aria-label="Favorite"
                  aria-pressed={favorite}
                  onClick={() => onToggleFavorite(option.value)}
                  className={cn(
                    "absolute right-8 bottom-1.5 grid size-4 place-items-center rounded-sm text-muted-foreground transition-opacity outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                    favorite
                      ? "text-brand hover:text-brand"
                      : "opacity-0 group-hover/row:opacity-100",
                  )}
                >
                  <Star className={cn("size-3.5", favorite && "fill-current")} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {note ? (
        <div className="mt-1 border-t border-border px-2 pt-1.5 pb-1 text-[11px] leading-4 text-muted-foreground">
          {note}
        </div>
      ) : null}
    </>
  );
}

export interface PromptModelMenuProps {
  models: PromptOption[];
  model: string | undefined;
  onModelChange: (model: string) => void;
  /** Models picked alongside `model` by shift-clicking; the message goes to each. */
  extraModels?: string[];
  /** Shift-click in the model list; without it, shift-click picks like a click. */
  onToggleModel?: (model: string) => void;
  /** Starred models, listed under the rail's Favorites. */
  favorites: string[];
  onToggleFavorite: (model: string) => void;
  /** Lowest first; the row is left out when the model takes none. */
  efforts: PromptOption[];
  effort: string | undefined;
  onEffortChange: (effort: string) => void;
  /** Left out when the model has no fast mode. */
  fast?: { readonly on: boolean; readonly onChange: (on: boolean) => void } | undefined;
  disabled?: boolean;
  /** Open the menu with that list out, as bindings like `mod+shift+m`. */
  modelShortcut?: string;
  effortShortcut?: string;
}

type Flyout = "effort" | "model";

/** Model, effort and fast mode behind one trigger; the effort and model lists fly out beside the menu. */
export function PromptModelMenu({
  models,
  model,
  onModelChange,
  extraModels = [],
  onToggleModel,
  favorites,
  onToggleFavorite,
  efforts,
  effort,
  onEffortChange,
  fast,
  disabled = false,
  modelShortcut,
  effortShortcut,
}: PromptModelMenuProps) {
  const [open, setOpenState] = useState(false);
  const [instant, setInstant] = useState(false);
  const [flyout, setFlyout] = useState<Flyout | null>(null);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    setInstant(false);
    if (!next) setFlyout(null);
  };
  const openWith = (list: Flyout) => {
    setOpenState(true);
    setInstant(true);
    setFlyout(list);
  };
  usePickerOpener(() => openWith("model"), { shortcut: modelShortcut, disabled });
  usePickerOpener(() => openWith("effort"), { shortcut: effortShortcut, disabled });
  const current = models.find((option) => option.value === model);
  const currentEffort = efforts.find((option) => option.value === effort);
  const modelIcon = current?.groupIcon ?? current?.icon;
  const modelLabel = extraModels.length
    ? `${extraModels.length + 1} models`
    : (current?.label ?? "Choose model");
  const flyoutProps = (list: Flyout) => ({
    open: flyout === list,
    onOpenChange: (next: boolean) =>
      setFlyout((shown) => (next ? list : shown === list ? null : shown)),
  });

  return (
    <MorphPopover open={open} onOpenChange={setOpen} className="min-w-0">
      <MorphPopoverTrigger>
        <PickerTrigger
          open={open}
          disabled={disabled}
          icon={modelIcon}
          compact={false}
          title={[modelLabel, currentEffort?.label, fast?.on && "Fast"]
            .filter((part) => typeof part === "string")
            .join(" · ")}
        >
          {modelLabel}
          {currentEffort ? (
            <span className="ml-1.5 text-muted-foreground/70">{currentEffort.label}</span>
          ) : null}
          {fast?.on ? (
            <Zap aria-label="Fast" className="ml-1 inline size-3 fill-current align-[-1px]" />
          ) : null}
        </PickerTrigger>
      </MorphPopoverTrigger>
      <MorphPopoverContent
        side="top"
        align="start"
        sideOffset={6}
        radius={12}
        instant={instant}
        className="w-56 p-1"
      >
        <MorphPopoverMenu>
          {fast ? (
            <div
              onPointerEnter={() => setFlyout(null)}
              className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-foreground"
            >
              <span className="flex-1">Fast</span>
              <Switch
                size="sm"
                checked={fast.on}
                onCheckedChange={fast.onChange}
                ariaLabel="Fast"
              />
            </div>
          ) : null}
          {efforts.length ? (
            <FlyoutRow
              label="Effort"
              value={currentEffort?.label ?? "Default"}
              {...flyoutProps("effort")}
            >
              <OptionList
                options={efforts}
                value={effort}
                onChange={onEffortChange}
                onClose={() => setOpen(false)}
                focusSelected
              />
            </FlyoutRow>
          ) : null}
          <FlyoutRow
            label="Model"
            value={
              <>
                {modelIcon ? (
                  <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5">
                    {modelIcon}
                  </span>
                ) : null}
                <span className="truncate">{modelLabel}</span>
              </>
            }
            className="p-0"
            {...flyoutProps("model")}
          >
            <ModelList
              models={models}
              value={model}
              onChange={onModelChange}
              onClose={() => setOpen(false)}
              multi={extraModels}
              onToggle={onToggleModel}
              favorites={favorites}
              onToggleFavorite={onToggleFavorite}
            />
          </FlyoutRow>
        </MorphPopoverMenu>
      </MorphPopoverContent>
    </MorphPopover>
  );
}

/** A menu row whose list flies out beside the menu, on hover or click (or → from the keyboard). */
function FlyoutRow({
  label,
  value,
  open,
  onOpenChange,
  className = "w-56 p-1",
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The flyout panel's. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <MorphPopover open={open} onOpenChange={onOpenChange} className="flex w-full">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(true)}
        onPointerEnter={() => onOpenChange(true)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          onOpenChange(true);
        }}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground transition-colors outline-none hover:bg-muted focus-visible:bg-muted",
          open && "bg-muted",
        )}
      >
        <span className="shrink-0">{label}</span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {value}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      <MorphPopoverContent side="right" sideOffset={8} radius={12} className={className}>
        {children}
      </MorphPopoverContent>
    </MorphPopover>
  );
}

/**
 * Models beside a rail of Favorites and one tab per group (harness); typing searches every group.
 * Mounted only while the flyout is open.
 */
export function ModelList({
  models,
  value,
  onChange,
  onClose,
  multi,
  onToggle,
  favorites,
  onToggleFavorite,
}: Pick<PromptSelectProps, "value" | "onChange" | "multi" | "onToggle"> & {
  models: PromptOption[];
  onClose: () => void;
  favorites: string[];
  onToggleFavorite: (value: string) => void;
}) {
  const groups = [
    ...new Map(
      models.flatMap((option) => (option.group ? [[option.group, option.groupIcon] as const] : [])),
    ),
  ];
  const current = models.find((option) => option.value === value);
  // Null is the Favorites tab. Opens where the current model is.
  const [tab, setTab] = useState<string | null>(() =>
    current && favorites.includes(current.value)
      ? null
      : (current?.group ?? groups[0]?.[0] ?? null),
  );
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const groupOf = (option: PromptOption) => groups.findIndex(([group]) => group === option.group);
  // A tab is one group, so its rows go without the group header; Favorites rows show whose they are.
  const shown = needle
    ? models
        .filter((option) =>
          [option.value, option.label].some(
            (text) => typeof text === "string" && text.toLowerCase().includes(needle),
          ),
        )
        .toSorted((a, b) => groupOf(a) - groupOf(b))
    : models.flatMap(({ group, ...option }) =>
        tab === null
          ? favorites.includes(option.value)
            ? [{ ...option, icon: option.groupIcon }]
            : []
          : group === tab
            ? [option]
            : [],
      );

  // The panel mounts in a portal and morphs in, so `autoFocus` fires too early.
  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="flex">
      <div
        role="tablist"
        aria-orientation="vertical"
        className="flex flex-col gap-1 border-r border-border p-1"
      >
        {[
          { key: null, label: "Favorites", icon: <Star /> },
          ...groups.map(([group, icon]) => ({ key: group, label: group, icon })),
        ].map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={!needle && tab === entry.key}
            aria-label={entry.label}
            title={entry.label}
            onClick={() => {
              setTab(entry.key);
              setQuery("");
            }}
            className={cn(
              "grid size-8 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted [&_svg]:size-4",
              !needle && tab === entry.key && "bg-muted text-foreground",
            )}
          >
            {entry.icon}
          </button>
        ))}
      </div>
      <div className="w-60 p-1">
        <label className="mb-1 flex h-8 items-center gap-2 border-b border-border px-2 text-muted-foreground">
          <Search className="size-3.5 shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                listRef.current
                  ?.querySelector<HTMLElement>('[role="option"]:not(:disabled)')
                  ?.focus();
              }
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              const first = shown.find((option) => !option.disabled);
              if (!first) return;
              onChange(first.value);
              onClose();
            }}
            placeholder="Search models"
            aria-label="Search models"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </label>
        {/* Fixed height: switching tabs or searching would otherwise resize the panel under the pointer. */}
        <div ref={listRef} className="h-80">
          <OptionList
            options={shown}
            value={value}
            onChange={onChange}
            onClose={onClose}
            searchThreshold={Infinity}
            empty={
              needle ? "No matches" : tab === null ? "Star a model to keep it here" : "No models"
            }
            multi={multi}
            onToggle={onToggle}
            favorites={favorites}
            onToggleFavorite={onToggleFavorite}
          />
        </div>
      </div>
    </div>
  );
}
