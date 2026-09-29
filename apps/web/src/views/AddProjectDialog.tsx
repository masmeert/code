import { ScrollArea } from "@apcode/ui/components/scroll-area";
import { cn } from "@apcode/ui/lib/utils";
import { Button } from "@apcode/ui/motion/button/base";
import { Input } from "@apcode/ui/motion/input";
import { MorphingModal } from "@apcode/ui/motion/morphing-modal";
import { Tabs, TabsList, TabsTrigger } from "@apcode/ui/motion/tabs";
import { ArrowUp, Folder, FolderOpen, LoaderCircle, Monitor, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { finishAddProject, pickLocalProject, useAddProjectOpen } from "../lib/projects.ts";
import { addProjectOn, cloneProject, listFolders, useStore } from "../lib/store.ts";

const THIS_MAC = "\u0000this-mac";

/** Where a new project lives once there are remote hosts: this Mac, or a folder on one of them. */
export function AddProjectDialog() {
  const open = useAddProjectOpen();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finishAddProject(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <MorphingModal
      viewId={open ? "add-project" : null}
      onClose={() => finishAddProject(null)}
      placement="center"
      className="max-w-lg"
    >
      {open ? <AddProject /> : null}
    </MorphingModal>
  );
}

function AddProject() {
  const hosts = useStore((s) => s.hosts);
  const addProjectFolder = useStore((s) => s.settings.addProjectFolder);
  const [host, setHost] = useState<string | null>(null);
  // The remote folder on show, which a clone goes into.
  const [folder, setFolder] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-medium">Add project</h2>
      <Tabs
        value={host ?? THIS_MAC}
        onValueChange={(value) => {
          setHost(value === THIS_MAC ? null : value);
          setFolder(null);
        }}
      >
        <TabsList>
          <TabsTrigger value={THIS_MAC}>
            <span className="flex items-center gap-1.5">
              <Monitor className="size-3.5" />
              This Mac
            </span>
          </TabsTrigger>
          {Object.keys(hosts).map((alias) => (
            <TabsTrigger key={alias} value={alias}>
              <span className="flex items-center gap-1.5">
                <Server className="size-3.5" />
                {alias}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {host === null ? (
        <Button
          variant="secondary"
          className="self-start rounded-lg"
          onClick={() =>
            void pickLocalProject().then((path) => {
              if (path) finishAddProject(path);
            })
          }
        >
          <FolderOpen className="size-4" />
          Choose folder…
        </Button>
      ) : (
        <RemoteFolders key={host} host={host} onFolder={setFolder} />
      )}
      <CloneRepository
        key={host ?? THIS_MAC}
        host={host}
        parent={host === null ? (addProjectFolder ?? "~") : folder}
      />
    </div>
  );
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.split("/").at(-1) || path;

/** Browses a remote host's folders, since this Mac's picker can't see them. */
function RemoteFolders({
  host,
  onFolder,
}: {
  host: string;
  onFolder: (path: string | null) => void;
}) {
  const connected = useStore((s) => s.hosts[host]?.connected ?? false);
  const [path, setPath] = useState("~");
  const [typed, setTyped] = useState("~");
  const [listing, setListing] = useState<{
    readonly path: string;
    readonly folders: ReadonlyArray<string>;
    readonly error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!connected) return;
    let current = true;
    setListing(null);
    void listFolders(host, path).then((result) => {
      if (!current) return;
      setListing(
        result ?? {
          path,
          folders: [],
          error: `${host} didn't answer. Check it in Settings → Connections.`,
        },
      );
      if (result) setTyped(result.path);
      onFolder(result && !result.error ? result.path : null);
    });
    return () => {
      current = false;
    };
  }, [host, path, connected, onFolder]);

  if (!connected)
    return (
      <p className="text-xs text-muted-foreground">
        {host} isn't connected yet. Its status is in Settings → Connections.
      </p>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Parent folder"
          className="size-8 shrink-0 rounded-lg"
          disabled={!listing || listing.path === "/"}
          onClick={() => listing && setPath(parentOf(listing.path))}
        >
          <ArrowUp className="size-4" />
        </Button>
        <Input
          aria-label={`Folder on ${host}`}
          value={typed}
          onChange={setTyped}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed.trim()) setPath(typed.trim());
          }}
          className="min-w-0 flex-1"
          classNames={{ field: "h-8 rounded-lg bg-background", input: "pl-2.5 font-mono text-xs" }}
        />
      </div>
      <ScrollArea className="h-56 rounded-xl border border-border bg-card">
        {!listing ? (
          <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            Reading folders…
          </p>
        ) : listing.error ? (
          <p className="p-3 text-xs text-destructive">{listing.error}</p>
        ) : listing.folders.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">No folders in here.</p>
        ) : (
          <div className="flex flex-col p-1">
            {listing.folders.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setPath(`${listing.path.replace(/\/$/, "")}/${name}`)}
                className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
      <Button
        className="self-end rounded-lg"
        disabled={!listing || listing.error !== null}
        onClick={() => {
          if (!listing) return;
          addProjectOn(host, listing.path);
          finishAddProject(listing.path);
        }}
      >
        Add {listing && !listing.error ? nameOf(listing.path) : "folder"}
      </Button>
    </div>
  );
}

/** Clones a repository into a new folder under `parent` and adds that as the project. */
function CloneRepository({ host, parent }: { host: string | null; parent: string | null }) {
  const [url, setUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clone = async () => {
    if (!parent || !url.trim() || cloning) return;
    setCloning(true);
    setError(null);
    const cloned = await cloneProject(host, url.trim(), parent);
    setCloning(false);
    if (cloned.path) finishAddProject(cloned.path);
    else setError(cloned.error);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">
        Or clone a repository into{" "}
        {parent ? <span className="font-mono">{parent}</span> : "the folder above"}
        {host ? ` on ${host}` : ""}
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Repository URL"
          value={url}
          onChange={setUrl}
          placeholder="https://github.com/owner/repo or git@…"
          spellCheck={false}
          autoComplete="off"
          disabled={cloning}
          onKeyDown={(e) => {
            if (e.key === "Enter") void clone();
          }}
          className="min-w-0 flex-1"
          classNames={{ field: "h-8 rounded-lg bg-background", input: "pl-2.5 font-mono text-xs" }}
        />
        <Button
          variant="secondary"
          className={cn("h-8 rounded-lg", cloning && "pointer-events-none")}
          disabled={!parent || !url.trim() || cloning}
          onClick={() => void clone()}
        >
          {cloning ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {cloning ? "Cloning…" : "Clone"}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
