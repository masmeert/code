import { PromptInput, PromptSelect, PromptSlider } from "@apcode/ui/agents/prompt-input";
import { ProjectBadge } from "@/components/project-badge";
import { useRowCursor } from "@apcode/ui/hooks/use-row-cursor";
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
  ListChecks,
  LockOpen,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  EFFORT_LABEL,
  EFFORTS,
  fromText,
  LARGE_PASTE_BYTES,
  PERMISSION_DESCRIPTION,
  PERMISSION_LABEL,
  PERMISSIONS,
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
import { UsageMeter } from "./UsageMeter.tsx";

const PERMISSION_ICON: Record<PermissionLevel, typeof ShieldCheck> = {
  plan: ListChecks,
  ask: ShieldCheck,
  "auto-edit": FilePen,
  auto: Sparkles,
  "full-access": LockOpen,
};

function permissionOption(level: PermissionLevel) {
  const Icon = PERMISSION_ICON[level];
  return {
    value: level,
    label: PERMISSION_LABEL[level],
    description: PERMISSION_DESCRIPTION[level],
    icon: <Icon />,
  };
}

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

interface MenuItem {
  readonly id: string;
  readonly name: string;
  readonly hint?: string;
  readonly description: string;
}

const MAX_FILE_MATCHES = 50;

/** Paths containing `query`, file-name matches first, then shallower paths. */
function matchFiles(files: ReadonlyArray<string>, query: string) {
  function rank(path: string) {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    return name.startsWith(query) ? 0 : name.includes(query) ? 1 : 2;
  }
  return files
    .flatMap((path) => (path.toLowerCase().includes(query) ? [{ path, rank: rank(path) }] : []))
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)
    .slice(0, MAX_FILE_MATCHES)
    .map(({ path }) => path);
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
  const [dismissed, setDismissed] = useState<string | null>(null);
  const slashItems: Array<SlashItem> =
    slashQuery === null || dismissed === draft.text
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
  const slashTyped = slashQuery !== null;
  useEffect(() => {
    if (slashTyped && threadId) send(ClientCommand.cases["thread.listCommands"].make({ threadId }));
  }, [slashTyped, threadId]);

  const pickSlash = (item: SlashItem) => {
    if (item.run) {
      setText("");
      item.run();
    } else setText(`/${item.name} `);
  };

  // --- @ mentions: "@" at the start or after whitespace searches the project's files.
  const input = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  function trackCaret(event: SyntheticEvent<HTMLTextAreaElement>) {
    input.current = event.currentTarget;
    setCaret(event.currentTarget.selectionStart);
  }
  const mention = props.cwd ? /(?:^|\s)@(\S*)$/.exec(draft.text.slice(0, caret)) : null;
  const mentionQuery = mention && dismissed !== draft.text ? mention[1]!.toLowerCase() : null;
  const repoFiles = useStore((s) => (props.cwd ? s.files[props.cwd] : undefined));
  const fileMatches = useMemo(
    () => (repoFiles && mentionQuery !== null ? matchFiles(repoFiles, mentionQuery) : []),
    [repoFiles, mentionQuery],
  );
  const mentionTyped = mention !== null;
  useEffect(() => {
    if (mentionTyped && props.cwd)
      send(ClientCommand.cases["git.listFiles"].make({ path: props.cwd }));
  }, [mentionTyped, props.cwd]);

  const pickFile = (path: string) => {
    const start = caret - mention![1]!.length - 1;
    const end = caret + /^\S*/.exec(draft.text.slice(caret))![0].length;
    // Quoted so a path with spaces still reads as one mention.
    const token = /\s/.test(path) ? `@"${path}" ` : `@${path} `;
    const rest = draft.text.slice(end).replace(/^ +/, "");
    const nextCaret = start + token.length;
    setText(draft.text.slice(0, start) + token + rest);
    setCaret(nextCaret);
    requestAnimationFrame(() => input.current?.setSelectionRange(nextCaret, nextCaret));
  };

  const menu =
    slashItems.length > 0
      ? {
          label: "Commands",
          items: slashItems.map((item) => ({
            id: item.name,
            name: `/${item.name}`,
            hint: item.hint,
            description: item.description,
          })),
          pick: (index: number) => pickSlash(slashItems[index]!),
          empty: null,
        }
      : mentionQuery !== null
        ? {
            label: "Files",
            items: fileMatches.map((path) => ({
              id: path,
              name: path.slice(path.lastIndexOf("/") + 1),
              description: path.slice(0, path.lastIndexOf("/") + 1),
            })),
            pick: (index: number) => pickFile(fileMatches[index]!),
            empty: repoFiles ? "No matching files" : "Loading files…",
          }
        : null;
  const reduceMotion = useReducedMotion();
  const {
    activeIndex: menuIndex,
    pointed,
    moveTo,
    moveActive,
  } = useRowCursor(menu?.items ?? [], slashQuery ?? mentionQuery ?? "", { loop: true });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    input.current = event.currentTarget;
    if (menu && event.key === "Escape") {
      event.preventDefault();
      setDismissed(draft.text);
      return;
    }
    if (menu?.items.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveActive(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        menu.pick(menuIndex);
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
        {menu ? (
          <SuggestionMenu
            label={menu.label}
            items={menu.items}
            empty={menu.empty}
            active={menuIndex}
            // Glides after the pointer only, like the command palette: arrow keys want each step at once.
            glide={pointed && !reduceMotion}
            onPoint={moveTo}
            onPick={menu.pick}
          />
        ) : null}
        <PromptInput
          value={draft.text}
          onValueChange={(text) => {
            if (recall.current && text !== recall.current.text) recall.current = null;
            setText(text);
            setCaret(input.current?.selectionStart ?? text.length);
          }}
          onKeyDown={onKeyDown}
          onSelect={trackCaret}
          onFocus={trackCaret}
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
              options={PERMISSIONS[props.provider].map(permissionOption)}
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
                {threadId ? (
                  <UsageMeter
                    threadId={threadId}
                    provider={props.provider}
                    busy={props.busy ?? false}
                  />
                ) : null}
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

function SuggestionMenu({
  label,
  items,
  empty,
  active,
  glide,
  onPoint,
  onPick,
}: {
  label: string;
  items: ReadonlyArray<MenuItem>;
  /** Shown when there are no items. */
  empty: string | null;
  active: number;
  /** Whether the highlight glides to the active row, rather than appearing there. */
  glide: boolean;
  onPoint: (id: string) => void;
  onPick: (index: number) => void;
}) {
  const highlightId = useId();
  return (
    // layoutScroll: the glide accounts for how far the list is scrolled. isolate: the highlight
    // passes under the rows it crosses instead of over the ones before its own.
    <motion.div
      role="listbox"
      aria-label={label}
      layoutScroll
      className="absolute inset-x-0 bottom-full isolate z-20 mb-2 max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1.5 shadow-panel"
    >
      {items.length ? null : (
        <div className="px-2.5 py-1.5 text-xs text-muted-foreground">{empty}</div>
      )}
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          ref={index === active ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined}
          // Not mouseenter: rows scrolling under a resting pointer would take the highlight from the keyboard.
          onMouseMove={index === active ? undefined : () => onPoint(item.id)}
          // Keep focus in the textarea.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(index)}
          className={cn(
            "relative flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none",
            index === active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {index === active ? (
            <motion.span
              layoutId={highlightId}
              transition={glide ? { type: "spring", stiffness: 480, damping: 38 } : { duration: 0 }}
              className="pointer-events-none absolute inset-0 -z-10 rounded-lg bg-muted"
            />
          ) : null}
          <span className="shrink-0 font-mono text-foreground">{item.name}</span>
          {item.hint ? (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
              {item.hint}
            </span>
          ) : null}
          <span className="min-w-0 truncate text-xs">{item.description}</span>
        </button>
      ))}
    </motion.div>
  );
}

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
