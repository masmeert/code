import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@masscode/ui/motion/select";
import { Input } from "@masscode/ui/motion/input";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@masscode/ui/motion/popover-morph";
import { ModelList } from "@masscode/ui/agents/prompt-input";
import { cn } from "@masscode/ui/lib/utils";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { getFavoriteChoices, buildModelChoices } from "../../lib/models.ts";
import { toggleFavoriteModel, useStore } from "../../lib/store.ts";

export function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-2 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Grouped list: one rounded surface, rows separated by hairlines. No overflow clip, so selects can open out of it. */
export function SettingsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-rule rounded-xl border border-border bg-card">{children}</div>
  );
}

export function SettingsRow({
  label,
  children,
}: {
  label: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
      <div className="min-w-0 flex-1">{label}</div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}

/** A settings dropdown; `label` is what the closed trigger shows when an option's content isn't plain text. */
export function SettingsSelect<Value extends string>(props: {
  value: Value;
  onChange: (value: Value) => void;
  options: ReadonlyArray<{ value: Value; label: string; icon?: React.ReactNode }>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={props.value}
      // SAFETY: the items below are rendered from `options`, whose values are all `Value`s.
      onValueChange={(value) => props.onChange(value as Value)}
      disabled={props.disabled}
      className={props.className ?? "w-44"}
    >
      <SelectTrigger className="py-1.5 text-[13px] whitespace-nowrap">
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent>
        {props.options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            label={option.label}
            className="text-[13px]"
          >
            {option.icon ? (
              <span className="flex items-center gap-1.5">
                {option.icon}
                {option.label}
              </span>
            ) : (
              option.label
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Every linked harness's models behind the composer's favorites and harness tabs, under a row for `fallback` (saved as null). */
export function SettingsModelSelect(props: {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  fallback: string;
  className: string;
}) {
  const settings = useStore((state) => state.settings);
  const providers = useStore((state) => state.providers);
  const [isOpen, setIsOpen] = useState(false);
  const models = buildModelChoices(providers, settings);
  const current = models.find((option) => option.value === props.value);

  return (
    <MorphPopover open={isOpen} onOpenChange={setIsOpen} className={props.className}>
      <MorphPopoverTrigger>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-[12px] border border-border bg-background px-3 py-1.5 text-[13px] whitespace-nowrap text-foreground transition-colors outline-none hover:border-border-strong focus-visible:ring-4 focus-visible:ring-ring"
        >
          {current ? (
            <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5">
              {current.groupIcon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-left">
            {current?.label ?? props.fallback}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out",
              isOpen && "rotate-180",
            )}
          />
        </button>
      </MorphPopoverTrigger>
      <MorphPopoverContent side="bottom" align="start" sideOffset={6} radius={12}>
        <div className="border-b border-border p-1">
          <button
            type="button"
            onClick={() => {
              props.onChange(null);
              setIsOpen(false);
            }}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors outline-none hover:bg-muted focus-visible:bg-muted",
              current ? "text-muted-foreground hover:text-foreground" : "text-foreground",
            )}
          >
            <span className="flex-1">{props.fallback}</span>
            {current ? null : <Check className="size-3.5 shrink-0" />}
          </button>
        </div>
        <ModelList
          models={models}
          value={current?.value}
          onChange={props.onChange}
          onClose={() => setIsOpen(false)}
          favorites={getFavoriteChoices(settings)}
          onToggleFavorite={toggleFavoriteModel}
        />
      </MorphPopoverContent>
    </MorphPopover>
  );
}

export function RowLabel({ title, description }: { title: string; description: string }) {
  return (
    <>
      <p>{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </>
  );
}

/** Text setting saved on blur or Enter. Esc reverts an edit; with nothing to revert it closes Settings as usual. */
export function SettingsTextField(props: {
  label: string;
  value: string;
  placeholder: string;
  isMonospace?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);

  return (
    <Input
      aria-label={props.label}
      value={draft}
      onChange={setDraft}
      placeholder={props.placeholder}
      spellCheck={false}
      autoComplete="off"
      onBlur={() => draft.trim() !== props.value && props.onCommit(draft.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape" && draft !== props.value) {
          event.stopPropagation();
          setDraft(props.value);
        }
      }}
      className="w-64"
      classNames={{
        field: "h-8 rounded-lg bg-background",
        input: cn("pl-2.5 text-[13px]", props.isMonospace && "font-mono text-xs"),
      }}
    />
  );
}
