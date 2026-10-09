import { Textarea } from "@masscode/ui/components/textarea";
import { matches } from "@masscode/ui/lib/keys";
import { Button } from "@masscode/ui/motion/button/base";
import { Input } from "@masscode/ui/motion/input";
import { MorphingModal } from "@masscode/ui/motion/morphing-modal";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../components/icon-button.tsx";
import { normalizeUrl } from "../lib/browser.ts";
import { formatKeybinding, KEYBINDINGS } from "../lib/keybindings.ts";
import { readProjectConfig, updateProjectConfig } from "../lib/store.ts";

interface ScriptsEditorProps {
  host: string | null;
  path: string;
  onClose: () => void;
  onSaved: () => void;
}

interface ScriptDraft {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly previewUrl: string;
}

function blankScript(): ScriptDraft {
  return { id: crypto.randomUUID(), name: "", command: "", previewUrl: "" };
}

/** Rows left blank are dropped on save rather than refused. */
function filledScripts(scripts: ReadonlyArray<ScriptDraft>) {
  return scripts.filter(
    (script) => script.name.trim() || script.command.trim() || script.previewUrl.trim(),
  );
}

/** What keeps `script` from saving, in plain words; empty when it can. */
function problemsOf(script: ScriptDraft, filled: ReadonlyArray<ScriptDraft>) {
  const name = script.name.trim();
  return [
    name ? null : "Name it, like Dev server.",
    name && filled.some((other) => other !== script && other.name.trim() === name)
      ? "Another script has this name; give it its own."
      : null,
    script.command.trim() ? null : "Add the command it runs, like pnpm dev.",
    !script.previewUrl.trim() || normalizeUrl(script.previewUrl)
      ? null
      : "The preview URL isn't a web address; use one like http://localhost:3000.",
  ].filter((problem) => problem !== null);
}

/** The project's scripts as a list to edit; saving writes them to its `masscode.toml`. */
export function ScriptsEditor({ open, ...props }: ScriptsEditorProps & { open: boolean }) {
  return (
    <MorphingModal
      viewId={open ? "scripts" : null}
      onClose={props.onClose}
      placement="center"
      className="max-w-2xl"
    >
      {open ? <ScriptsForm {...props} /> : null}
    </MorphingModal>
  );
}

function ScriptsForm({ host, path, onClose, onSaved }: ScriptsEditorProps) {
  const [scripts, setScripts] = useState<ReadonlyArray<ScriptDraft> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Problems show once a save is tried, not while a row is still being filled in.
  const [showProblems, setShowProblems] = useState(false);
  const [addedId, setAddedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readProjectConfig(host, path).then((frame) => {
      if (cancelled) return;
      if (!frame) {
        return setError(
          "MassCode's daemon didn't answer, so the scripts couldn't be read. Check it's running and open this again.",
        );
      }

      const saved = frame.config.scripts ?? [];
      setScripts(
        saved.length
          ? saved.map((script) => ({
              id: crypto.randomUUID(),
              name: script.name,
              command: script.command,
              previewUrl: script.preview_url ?? "",
            }))
          : [blankScript()],
      );
      setNotice(
        frame.error
          ? `${frame.error}. Saving replaces it.`
          : frame.text && /^\s*#/m.test(frame.text)
            ? "masscode.toml has comments in it; saving here rewrites the file without them."
            : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [host, path]);

  function updateScript(id: string, patch: Partial<ScriptDraft>) {
    setScripts(
      (current) =>
        current && current.map((script) => (script.id === id ? { ...script, ...patch } : script)),
    );
    setError(null);
  }

  async function save() {
    if (!scripts || saving) return;

    const filled = filledScripts(scripts);
    if (filled.some((script) => problemsOf(script, filled).length > 0)) {
      return setShowProblems(true);
    }

    setSaving(true);
    const failed = await updateProjectConfig(host, path, ({ scripts: _replaced, ...rest }) =>
      filled.length
        ? {
            ...rest,
            scripts: filled.map((script) => ({
              name: script.name.trim(),
              command: script.command.trim(),
              ...(script.previewUrl.trim() && {
                preview_url: normalizeUrl(script.previewUrl) ?? "",
              }),
            })),
          }
        : rest,
    );
    setSaving(false);
    if (failed) setError(failed);
    else onSaved();
  }

  return (
    <div
      className="flex flex-col gap-4"
      onKeyDown={(event) => {
        if (!matches(event, KEYBINDINGS["scripts.save"])) return;
        event.preventDefault();
        void save();
      }}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-medium">Scripts</h2>
        <p className="truncate text-xs text-muted-foreground" title={`${path}/masscode.toml`}>
          Saved to masscode.toml in the project; commit it to share them with your team
        </p>
      </div>
      {notice ? (
        <p className="rounded-lg border border-warning/40 px-3 py-2 text-xs text-warning">
          {notice}
        </p>
      ) : null}
      {scripts === null ? (
        error ? null : (
          <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 motion-safe:animate-spin" />
            Reading the project's scripts…
          </div>
        )
      ) : (
        <div className="-mx-1 max-h-[65vh] overflow-y-auto px-1">
          <div className="divide-y divide-rule rounded-xl border border-border bg-card">
            {scripts.map((script) => {
              const problems = showProblems ? problemsOf(script, filledScripts(scripts)) : [];

              return (
                <div key={script.id} className="flex flex-col gap-2 px-3 py-3">
                  <div className="flex items-start gap-2">
                    <Input
                      aria-label="Script name"
                      placeholder="Name"
                      autoFocus={script.id === addedId}
                      value={script.name}
                      onChange={(name) => updateScript(script.id, { name })}
                      error={problems.length > 0 && !script.name.trim()}
                      className="w-40 shrink-0"
                      classNames={{
                        field: "h-8 rounded-lg bg-background",
                        input: "pl-2.5 text-[13px]",
                      }}
                    />
                    <Textarea
                      aria-label="Command"
                      placeholder="Command, like pnpm dev"
                      rows={1}
                      spellCheck={false}
                      value={script.command}
                      aria-invalid={problems.length > 0 && !script.command.trim()}
                      onChange={(event) => updateScript(script.id, { command: event.target.value })}
                      className="min-h-8 flex-1 rounded-lg bg-background py-1.5 font-mono text-xs leading-5 md:text-xs dark:bg-background"
                    />
                    <IconButton
                      label="Remove script"
                      className="mt-0.5"
                      onClick={() => setScripts(scripts.filter((other) => other.id !== script.id))}
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </div>
                  <Input
                    aria-label="Preview URL"
                    placeholder="Preview URL to open in the Browser panel (optional)"
                    spellCheck={false}
                    value={script.previewUrl}
                    onChange={(previewUrl) => updateScript(script.id, { previewUrl })}
                    error={
                      problems.length > 0 &&
                      script.previewUrl.trim() !== "" &&
                      !normalizeUrl(script.previewUrl)
                    }
                    className="mr-9"
                    classNames={{
                      field: "h-8 rounded-lg bg-background",
                      input: "pl-2.5 font-mono text-xs",
                    }}
                  />
                  {problems.length ? (
                    <p className="text-xs text-destructive">{problems.join(" ")}</p>
                  ) : null}
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => {
                const script = blankScript();
                setAddedId(script.id);
                setScripts([...scripts, script]);
              }}
              className="flex h-10 w-full items-center gap-2 rounded-b-xl px-3 text-[13px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-3.5" />
              Add script
            </button>
          </div>
        </div>
      )}
      {error ? (
        <p className="selectable text-xs whitespace-pre-wrap text-destructive">{error}</p>
      ) : null}
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
          <kbd aria-hidden className="font-sans text-[10px] text-muted-foreground">
            esc
          </kbd>
        </Button>
        <Button size="sm" disabled={scripts === null || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
          <kbd aria-hidden className="font-sans text-[10px] opacity-70">
            {formatKeybinding("scripts.save")}
          </kbd>
        </Button>
      </div>
    </div>
  );
}
