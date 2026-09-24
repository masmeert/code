"use client";
// beui.dev/components/agents/prompt-input

import { ArrowUp, Check, ChevronDown, CirclePlus, FileText, ImageIcon, Paperclip, Plus, Square, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverMenu,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

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

export type PromptModel = PromptOption;

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
  models?: PromptModel[];
  model?: string;
  defaultModel?: string;
  onModelChange?: (model: string) => void;
  actions?: PromptAction[];
  onAction?: (action: string) => void;
  onSubmit?: (value: string, model?: string) => void | Promise<void>;
  /** Blocks sending only; typing and the pickers stay usable. */
  submitDisabled?: boolean;
  loading?: boolean;
  onStop?: () => void;
  minRows?: number;
  maxRows?: number;
  leadingAction?: ReactNode;
  /** Extra pickers after the model menu, each separated by a hairline. */
  controls?: ReactNode[];
  attachments?: PromptAttachment[];
  /** Shows the paperclip button. */
  onAttach?: () => void;
  onRemoveAttachment?: (id: string) => void;
  /** Files pasted into the textarea. */
  onPasteFiles?: (files: File[]) => void;
  /** Strip tucked under the card; children lay out left-to-right, spread apart. */
  footer?: ReactNode;
  className?: string;
}

export function PromptInput({
  value,
  defaultValue = "",
  onValueChange,
  models = [],
  model,
  defaultModel,
  onModelChange,
  actions = [],
  onAction,
  onSubmit,
  submitDisabled = false,
  loading = false,
  onStop,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  controls = [],
  attachments = [],
  onAttach,
  onRemoveAttachment,
  onPasteFiles,
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
  const [internalModel, setInternalModel] = useState(
    defaultModel ?? models[0]?.value,
  );
  const [actionsOpen, setActionsOpen] = useState(false);
  const currentValue = value ?? internalValue;
  const currentModelValue = model ?? internalModel;
  const hasContent = Boolean(currentValue.trim()) || attachments.length > 0;
  const canSubmit = hasContent && !disabled && !submitDisabled && !loading;

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

  const setModel = (next: string) => {
    if (model === undefined) setInternalModel(next);
    onModelChange?.(next);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSubmit) return;

    onSubmit?.(currentValue.trim(), currentModelValue);
    if (value === undefined) setInternalValue("");
    textareaRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPasteFiles) return;
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    onPasteFiles(files);
  };

  const pickers = [
    models.length ? (
      <PromptSelect
        key="model"
        options={models}
        value={currentModelValue}
        onChange={setModel}
        disabled={disabled || loading}
        placeholder="Choose model"
        showOptionIcon
      />
    ) : null,
    ...controls,
  ].filter(Boolean);

  return (
    <div className={cn("w-full", className)}>
      <form
        onSubmit={submit}
        className={cn(
          "relative z-10 w-full rounded-2xl border border-border bg-card p-2 transition-colors focus-within:border-primary/25",
          disabled && "opacity-60",
        )}
      >
        <div
          ref={measurementRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-x-2 top-0 whitespace-pre-wrap px-2 text-sm leading-6 [overflow-wrap:break-word]"
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

        <div className="mt-2 flex min-h-8 items-center gap-1">
          {actions.length ? (
            <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
              <MorphPopoverTrigger>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled || loading}
                  aria-label="Add to prompt"
                  className="size-8 rounded-lg"
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
                    className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
                  >
                    {action.icon ? (
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                        {action.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0">
                      <span className="block text-sm text-foreground">
                        {action.label}
                      </span>
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
          <div className="flex min-w-0 items-center gap-0.5">
            {pickers.map((picker, index) => (
              <div key={index} className="flex min-w-0 items-center gap-0.5">
                {index > 0 ? (
                  <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-rule" />
                ) : null}
                {picker}
              </div>
            ))}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onAttach ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label="Attach files"
                onClick={onAttach}
                className="size-8 rounded-lg"
              >
                <Paperclip className="size-4" />
              </Button>
            ) : null}
            <Button
              type={loading ? "button" : "submit"}
              size="icon"
              disabled={loading ? !onStop : !canSubmit}
              aria-label={loading ? "Stop generating" : "Send prompt"}
              onClick={loading ? onStop : undefined}
              className="size-8 rounded-lg"
            >
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={loading ? "stop" : "send"}
                  initial={reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }}
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                  className="grid place-items-center"
                >
                  {loading ? (
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
        <div className="mx-3 flex h-8 items-center justify-between gap-3 rounded-b-xl border border-t-0 border-border bg-background px-1.5 text-xs text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </div>
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
        <img
          src={attachment.preview}
          alt=""
          className="size-6 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {attachment.image ? <ImageIcon className="size-3.5" /> : <FileText className="size-3.5" />}
        </span>
      )}
      <span className="min-w-0 truncate">{attachment.name}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${attachment.name}`}
          onClick={() => onRemove(attachment.id)}
          className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

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
  searchThreshold = 10,
  searchPlaceholder = "Filter…",
  onCreate,
  createLabel = (query) => `Create "${query}"`,
  side = "top",
  align = "start",
  width = "w-56",
  onOpenChange,
  className,
}: PromptSelectProps) {
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (!next) setQuery("");
    onOpenChange?.(next);
  };
  const current = options.find((option) => option.value === value);
  const triggerIcon = icon ?? (showOptionIcon ? current?.groupIcon ?? current?.icon : undefined);
  const searchable = Boolean(onCreate) || options.length >= searchThreshold;
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const visible = needle
    ? options.filter((option) => option.value.toLowerCase().includes(needle))
    : options;
  const canCreate = Boolean(onCreate && trimmed) && !options.some((option) => option.value === trimmed);

  const create = () => {
    onCreate?.(trimmed);
    setOpen(false);
  };

  // The panel mounts in a portal and morphs in, so `autoFocus` fires too early.
  useEffect(() => {
    if (!open || !searchable) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, searchable]);

  return (
    <MorphPopover open={open} onOpenChange={setOpen}>
      <MorphPopoverTrigger>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-7 max-w-56 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
            open && "bg-muted text-foreground",
            className,
          )}
        >
          {triggerIcon ? (
            <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5">{triggerIcon}</span>
          ) : null}
          <span className="truncate">{current?.label ?? placeholder}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </MorphPopoverTrigger>
      <MorphPopoverContent side={side} align={align} sideOffset={6} radius={12} className={cn(width, "p-1")}>
        {title ? <div className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">{title}</div> : null}
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
              if (exact) {
                onChange(exact.value);
                setOpen(false);
              } else if (canCreate) create();
              else if (first) {
                onChange(first.value);
                setOpen(false);
              }
            }}
            placeholder={searchPlaceholder}
            className="mb-1 h-7 w-full rounded-md bg-muted px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        ) : null}
        <div role="listbox" className="scrollbar-hide flex max-h-80 flex-col gap-0.5 overflow-y-auto overscroll-contain">
          {visible.length === 0 && !canCreate ? (
            <div className="px-2 py-1.5 text-[13px] text-muted-foreground">{needle ? "No matches" : empty ?? "Nothing here"}</div>
          ) : null}
          {canCreate ? (
            <button
              type="button"
              onClick={create}
              className="flex h-7 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
            >
              <CirclePlus className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{createLabel(trimmed)}</span>
            </button>
          ) : null}
          {canCreate && visible.length ? <div aria-hidden="true" className="mx-2 my-0.5 h-px shrink-0 bg-border" /> : null}
          {visible.map((option, index) => {
            const selected = option.value === value;
            const header = option.group && option.group !== visible[index - 1]?.group;
            return (
              <div key={option.value}>
                {header ? (
                  <div className={cn("flex items-center gap-1.5 px-2 pb-1 text-[11px] text-muted-foreground", index > 0 ? "mt-1 border-t border-border pt-2" : "pt-1")}>
                    {option.groupIcon ? <span className="grid size-3 place-items-center [&_svg]:size-3">{option.groupIcon}</span> : null}
                    {option.group}
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={option.disabled}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50",
                    option.description ? "py-1.5" : "h-7",
                    selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.icon ? (
                    <span
                      className={cn("grid size-4 shrink-0 place-items-center [&_svg]:size-3.5", option.description && "self-start")}
                      style={option.description ? { marginTop: 2 } : undefined}
                    >
                      {option.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{option.label}</span>
                      {option.badge ? <span className="grid shrink-0 place-items-center [&_svg]:size-3">{option.badge}</span> : null}
                    </span>
                    {option.description ? (
                      <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{option.description}</span>
                    ) : null}
                  </span>
                  {selected ? <Check className="size-3.5 shrink-0" /> : null}
                </button>
              </div>
            );
          })}
        </div>
        {note ? <div className="mt-1 border-t border-border px-2 pt-1.5 pb-1 text-[11px] leading-4 text-muted-foreground">{note}</div> : null}
      </MorphPopoverContent>
    </MorphPopover>
  );
}
