import { PromptInput, PromptSelect, PromptSlider } from "@apcode/ui/agents/prompt-input";
import { ProjectBadge } from "@/components/project-badge";
import { cn } from "@apcode/ui/lib/utils";
import {
  ClientCommand,
  Effort,
  PermissionLevel,
  type ProviderKind,
  type TurnOptions,
} from "@apcode/contracts";
import * as Schema from "effect/Schema";
import {
  Archive,
  FilePen,
  Folder,
  FolderPlus,
  FolderTree,
  GitBranch,
  LockOpen,
  ShieldCheck,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  EFFORT_LABEL,
  EFFORTS,
  fromText,
  LARGE_PASTE_BYTES,
  PERMISSION_DESCRIPTION,
  PERMISSION_LABEL,
  toTurnOptions,
  useAttachments,
  useTurnPrefs,
} from "../lib/composer.ts";
import { restoreStash, setDraft, stashDraft, useDraft, useStashes } from "../lib/drafts.ts";
import { describe, KEYBINDINGS, useKeybinding } from "../lib/keybindings.ts";
import { defaultEffort, type modelChoices, recommendedBadge } from "../lib/models.ts";
import { addProject } from "../lib/projects.ts";
import { send, useStore } from "../lib/store.ts";
import { ago, useNow } from "../lib/time.ts";

const PERMISSION_ICON: Record<PermissionLevel, typeof ShieldCheck> = {
  ask: ShieldCheck,
  "auto-edit": FilePen,
  "full-access": LockOpen,
};

const PERMISSION_OPTIONS = PermissionLevel.literals.map((level) => {
  const Icon = PERMISSION_ICON[level];
  return {
    value: level,
    label: PERMISSION_LABEL[level],
    description: PERMISSION_DESCRIPTION[level],
    icon: <Icon />,
  };
});

export interface ComposerProps {
  /** Whose draft, and effort/permission picks, these are: a thread id, or "draft:new". */
  prefsKey: string;
  provider: ProviderKind;
  /** Project folder; null in a draft whose project isn't picked yet. */
  cwd: string | null;
  /** The thread this composer writes to; enables slash commands. */
  threadId?: string;
  /** Prompts sent in this thread, oldest first, for ↑ recall. */
  history?: ReadonlyArray<string>;
  /** Drafts only: turns the folder chip into a project picker. */
  onPickProject?: (path: string | null) => void;
  /** Drafts only: where the new thread will run. */
  workspace?: {
    readonly value: "local" | "worktree";
    readonly onChange: (value: "local" | "worktree") => void;
  };
  busy?: boolean;
  disabled?: boolean;
  /** Keeps the composer usable but blocks sending (e.g. no project picked yet). */
  sendDisabled?: boolean;
  models: ReturnType<typeof modelChoices>;
  model: string | undefined;
  onModelChange: (value: string) => void;
  extraModels?: string[];
  onToggleModel?: (value: string) => void;
  placeholder: string;
  /** `alternate`: sent with ⌘/Ctrl+Enter, for the opposite of the usual behavior. */
  onSubmit: (text: string, options: TurnOptions, how: { alternate: boolean }) => void;
  onStop?: () => void;
}

interface SlashItem {
  readonly name: string;
  readonly description: string;
  readonly hint: string;
  /** Runs on pick instead of being inserted as text. */
  readonly run?: () => void;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export const Composer = (props: ComposerProps) => {
  const { prefsKey, threadId } = props;
  const [prefs, setPrefs] = useTurnPrefs(prefsKey, props.provider);
  const draft = useDraft(prefsKey);
  const files = useAttachments({ key: prefsKey, acceptDrops: !props.disabled });
  const providers = useStore((s) => s.providers);
  const stashes = useStashes();
  const [stashSignal, setStashSignal] = useState(0);
  // No pick means the model's own default, which the menu stars; picking the starred level keeps following it.
  const fallbackEffort = defaultEffort(providers, props.model);
  const effortOptions = EFFORTS[props.provider].map((effort) => ({
    value: effort,
    label: EFFORT_LABEL[effort],
    badge: effort === fallbackEffort ? recommendedBadge() : undefined,
  }));

  const setText = (text: string) => setDraft(prefsKey, (prev) => ({ ...prev, text }));

  // --- ↑ recall: walks back through sent prompts while the composer holds one untouched.
  const recall = useRef<{ index: number; text: string } | null>(null);
  const history = props.history ?? [];
  const recallTo = (index: number) => {
    const text = history[index] ?? "";
    recall.current = index < history.length ? { index, text } : null;
    setText(text);
  };

  // --- slash commands: "/" at the start opens the menu.
  const commands = useStore((s) => (threadId ? s.commands[threadId] : undefined));
  const slashQuery =
    threadId && /^\/\S*$/.test(draft.text) ? draft.text.slice(1).toLowerCase() : null;
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashItems: Array<SlashItem> =
    slashQuery === null || slashDismissed === draft.text
      ? []
      : [
          {
            name: "compact",
            description: "Summarize the conversation so far to free up context",
            hint: "",
            run: () => threadId && send(ClientCommand.cases["thread.compact"].make({ threadId })),
          },
          ...(commands ?? [])
            .filter((c) => c.name !== "compact")
            .map((c) => ({ name: c.name, description: c.description, hint: c.argumentHint })),
        ].filter((item) => item.name.toLowerCase().startsWith(slashQuery));
  const slashOpen = slashItems.length > 0;
  const slashTyped = slashQuery !== null;
  useEffect(() => {
    if (slashTyped && threadId) send(ClientCommand.cases["thread.listCommands"].make({ threadId }));
  }, [slashTyped, threadId]);
  useEffect(() => setSlashIndex(0), [slashQuery]);

  const pickSlash = (item: SlashItem) => {
    if (item.run) {
      setText("");
      item.run();
    } else setText(`/${item.name} `);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSlashIndex((i) => (i + step + slashItems.length) % slashItems.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        pickSlash(slashItems[Math.min(slashIndex, slashItems.length - 1)]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(draft.text);
        return;
      }
    }
    const textarea = event.currentTarget;
    const text = textarea.value;
    const untouched = text === "" || text === recall.current?.text;
    if (
      event.key === "ArrowUp" &&
      untouched &&
      history.length &&
      !text.slice(0, textarea.selectionStart).includes("\n")
    ) {
      const index = recall.current ? recall.current.index - 1 : history.length - 1;
      if (index < 0) return;
      event.preventDefault();
      recallTo(index);
    } else if (
      event.key === "ArrowDown" &&
      recall.current &&
      text === recall.current.text &&
      !text.slice(textarea.selectionEnd).includes("\n")
    ) {
      event.preventDefault();
      recallTo(recall.current.index + 1);
    }
  };

  // --- ⌘S stash: tucks the prompt away; on an empty composer, brings one back.
  useKeybinding(props.disabled ? undefined : "composer.stash", () => {
    if (stashDraft(prefsKey)) return;
    if (stashes.length === 1) restoreStash(prefsKey, stashes[0]!.id);
    else if (stashes.length > 1) setStashSignal((n) => n + 1);
  });

  const submit = (text: string, how: { alternate: boolean }) => {
    recall.current = null;
    const options = toTurnOptions(prefs, files.take());
    setDraft(prefsKey, { text: "", attachments: [] });
    props.onSubmit(text, options, how);
  };

  return (
    <div className="shrink-0 px-3 pb-3">
      <div className="relative mx-auto max-w-3xl">
        {slashOpen ? <SlashMenu items={slashItems} active={slashIndex} onPick={pickSlash} /> : null}
        <PromptInput
          value={draft.text}
          onValueChange={(text) => {
            if (recall.current && text !== recall.current.text) recall.current = null;
            setText(text);
          }}
          onKeyDown={onKeyDown}
          loading={props.busy ?? false}
          disabled={props.disabled ?? false}
          submitDisabled={props.sendDisabled ?? false}
          models={props.models}
          model={props.model}
          onModelChange={props.onModelChange}
          {...(props.extraModels ? { extraModels: props.extraModels } : {})}
          {...(props.onToggleModel ? { onToggleModel: props.onToggleModel } : {})}
          modelShortcut={KEYBINDINGS["picker.model"]}
          controls={[
            <PromptSlider
              key="effort"
              title="Effort"
              minLabel="Faster"
              maxLabel="Smarter"
              options={effortOptions}
              value={prefs.effort ?? fallbackEffort}
              onChange={(value) =>
                Schema.is(Effort)(value) &&
                setPrefs({ effort: value === fallbackEffort ? null : value })
              }
              placeholder="Default effort"
              disabled={props.disabled}
              shortcut={KEYBINDINGS["picker.effort"]}
            />,
            <PromptSelect
              key="permission"
              title="Permissions"
              options={PERMISSION_OPTIONS}
              value={prefs.permission}
              onChange={(value) =>
                Schema.is(PermissionLevel)(value) && setPrefs({ permission: value })
              }
              disabled={props.disabled}
              shortcut={KEYBINDINGS["picker.permission"]}
              showOptionIcon
              width="w-72"
              className={
                prefs.permission === "full-access" ? "text-warning hover:text-warning" : undefined
              }
            />,
          ]}
          attachments={[...files.attachments]}
          onAttach={() => void files.pick()}
          onRemoveAttachment={files.remove}
          onPasteFiles={(pasted) => void files.addFiles(pasted)}
          onPasteText={(text, plain) => {
            if (plain || byteLength(text) < LARGE_PASTE_BYTES) return false;
            files.add([fromText(text)]);
            return true;
          }}
          onSubmit={(text, _model, how) => submit(text, how ?? { alternate: false })}
          onStop={props.onStop}
          minRows={2}
          maxRows={10}
          placeholder={props.placeholder}
          data-composer=""
          footer={
            <>
              <span className="flex min-w-0 items-center gap-0.5">
                {props.onPickProject ? (
                  <ProjectSelect cwd={props.cwd} onPick={props.onPickProject} />
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5 px-1.5">
                    <Folder className="size-3.5 shrink-0" />
                    <span className="truncate">{props.cwd?.split("/").at(-1) ?? props.cwd}</span>
                  </span>
                )}
                {props.workspace ? <WorkspaceSelect {...props.workspace} /> : null}
              </span>
              <span className="flex min-w-0 items-center gap-0.5">
                {stashes.length ? (
                  <StashSelect prefsKey={prefsKey} openSignal={stashSignal} />
                ) : null}
                {props.cwd ? (
                  <BranchPicker cwd={props.cwd} disabled={props.busy ?? false} />
                ) : (
                  <span />
                )}
              </span>
            </>
          }
          autoFocus
        />
      </div>
    </div>
  );
};

const SlashMenu = ({
  items,
  active,
  onPick,
}: {
  items: ReadonlyArray<SlashItem>;
  active: number;
  onPick: (item: SlashItem) => void;
}) => (
  <div
    role="listbox"
    aria-label="Commands"
    className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 shadow-panel"
  >
    {items.map((item, index) => (
      <button
        key={item.name}
        type="button"
        role="option"
        aria-selected={index === active}
        // Keep focus in the textarea.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onPick(item)}
        className={cn(
          "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none",
          index === active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
        )}
      >
        <span className="shrink-0 font-mono text-foreground">/{item.name}</span>
        {item.hint ? (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
            {item.hint}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-xs">{item.description}</span>
      </button>
    ))}
  </div>
);

const StashSelect = ({ prefsKey, openSignal }: { prefsKey: string; openSignal: number }) => {
  const stashes = useStashes();
  const now = useNow();
  return (
    <PromptSelect
      title={`Stashed prompts · ${describe("composer.stash")} stashes the current one`}
      icon={<Archive />}
      options={stashes.map((stash) => ({
        value: stash.id,
        label: stash.text.split("\n")[0] || `${stash.attachments.length} files`,
        description: `${ago(stash.at, now)}${stash.attachments.length ? ` · ${stash.attachments.length} files` : ""}`,
      }))}
      value={undefined}
      placeholder={String(stashes.length)}
      onChange={(id) => restoreStash(prefsKey, id)}
      openSignal={openSignal}
      align="end"
      width="w-80"
      className="h-6 text-[11px]"
    />
  );
};

const WORKSPACE_OPTIONS = [
  { value: "local", label: "Local", description: "Work in the project folder", icon: <Folder /> },
  {
    value: "worktree",
    label: "New worktree",
    description: "A git worktree on its own branch, for parallel work",
    icon: <FolderTree />,
  },
];

const WorkspaceSelect = ({
  value,
  onChange,
}: {
  value: "local" | "worktree";
  onChange: (value: "local" | "worktree") => void;
}) => (
  <PromptSelect
    title="Workspace"
    options={WORKSPACE_OPTIONS}
    value={value}
    onChange={(next) => onChange(next === "worktree" ? "worktree" : "local")}
    shortcut={KEYBINDINGS["picker.workspace"]}
    showOptionIcon
    width="w-72"
    className="h-6 text-[11px]"
  />
);

const ADD_PROJECT = "\u0000add-project";

/** Which project a draft starts in; also the way to add one. */
const ProjectSelect = ({
  cwd,
  onPick,
}: {
  cwd: string | null;
  onPick: (path: string | null) => void;
}) => {
  const projects = useStore((s) => s.projects);
  const options = [
    ...[...projects]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({
        value: project.path,
        label: project.name,
        icon: <ProjectBadge project={project} />,
      })),
    { value: ADD_PROJECT, label: "Add project…", icon: <FolderPlus /> },
  ];
  return (
    <PromptSelect
      title="Project"
      icon={<Folder />}
      options={options}
      value={cwd ?? undefined}
      placeholder="Pick a project"
      onChange={(value) =>
        value === ADD_PROJECT
          ? void addProject().then((path) => path && onPick(path))
          : onPick(value)
      }
      width="w-64"
      className={cwd ? "h-6 text-[11px]" : "h-6 text-[11px] text-foreground"}
    />
  );
};

/** Current branch of the project folder; picking another checks it out. */
const BranchPicker = ({ cwd, disabled }: { cwd: string; disabled: boolean }) => {
  const list = useStore((s) => s.branches[cwd]);
  useEffect(() => send(ClientCommand.cases["git.listBranches"].make({ path: cwd })), [cwd]);

  if (!list) return null;
  if (!list.current && !list.branches.length)
    return <span className="px-1.5 text-muted-foreground/70">Not a git repo</span>;
  return (
    <PromptSelect
      title="Switch branch"
      icon={<GitBranch />}
      searchPlaceholder="Find or create a branch…"
      onCreate={(branch) =>
        send(ClientCommand.cases["git.createBranch"].make({ path: cwd, branch }))
      }
      createLabel={(branch) => (
        <>
          Create <span className="font-mono">{branch}</span>
        </>
      )}
      options={list.branches.map((branch) => ({ value: branch, label: branch }))}
      value={list.current ?? undefined}
      placeholder="Detached"
      onChange={(branch) =>
        branch !== list.current &&
        send(ClientCommand.cases["git.checkout"].make({ path: cwd, branch }))
      }
      onOpenChange={(open) =>
        open && send(ClientCommand.cases["git.listBranches"].make({ path: cwd }))
      }
      disabled={disabled}
      shortcut={KEYBINDINGS["picker.branch"]}
      note={
        list.error ? (
          <span className="whitespace-pre-wrap text-destructive">{list.error}</span>
        ) : undefined
      }
      align="end"
      width="w-72"
      className="h-6 font-mono text-[11px]"
    />
  );
};
