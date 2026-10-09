import { ScrollArea } from "@masscode/ui/components/scroll-area";
import { cn } from "@masscode/ui/lib/utils";
import { Button } from "@masscode/ui/motion/button/base";
import { Input } from "@masscode/ui/motion/input";
import { MorphingModal } from "@masscode/ui/motion/morphing-modal";
import { Tabs, TabsList, TabsTrigger } from "@masscode/ui/motion/tabs";
import { ArrowUp, Folder, FolderOpen, LoaderCircle, Monitor, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { finishAddProject, pickLocalProject, useAddProjectOpen } from "../lib/projects.ts";
import { addProjectOn, cloneProject, listFolders, useStore } from "../lib/store.ts";
import { buildMachineOptions, THIS_MAC, toMachine } from "../lib/machines.ts";

/** Where a new project lives once there are remote hosts: this Mac, or a folder on one of them. */
export function AddProjectDialog() {
  const isOpen = useAddProjectOpen();

  return (
    <MorphingModal
      viewId={isOpen ? "add-project" : null}
      onClose={() => finishAddProject(null)}
      placement="center"
      className="max-w-lg"
    >
      {isOpen ? <AddProject /> : null}
    </MorphingModal>
  );
}

function AddProject() {
  const hosts = useStore((state) => state.hosts);
  const addProjectFolder = useStore((state) => state.settings.addProjectFolder);
  const [host, setHost] = useState<string | null>(null);
  // The remote folder on show, which a clone goes into.
  const [folder, setFolder] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-medium">Add project</h2>
      <Tabs
        value={host ?? THIS_MAC}
        onValueChange={(value) => {
          setHost(toMachine(value));
          setFolder(null);
        }}
      >
        <TabsList>
          {buildMachineOptions(hosts).map((option) => (
            <TabsTrigger key={option.value} value={option.value}>
              <span className="flex items-center gap-1.5">
                {option.machine ? (
                  <Server className="size-3.5" />
                ) : (
                  <Monitor className="size-3.5" />
                )}
                {option.label}
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
        key={`clone:${host ?? THIS_MAC}`}
        host={host}
        parent={host === null ? (addProjectFolder ?? "~") : folder}
      />
    </div>
  );
}

function getParentPath(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function getFolderName(path: string) {
  return path.split("/").at(-1) || path;
}

interface FolderList {
  readonly path: string;
  readonly folders: ReadonlyArray<string>;
  readonly error: string | null;
}

/** Browses a remote host's folders, since this Mac's picker can't see them. */
function RemoteFolders({
  host,
  onFolder,
}: {
  host: string;
  onFolder: (path: string | null) => void;
}) {
  const isConnected = useStore((state) => state.hosts[host]?.connected ?? false);
  const projectsFolder = useStore((state) => state.settings.hostProjectFolders?.[host] || "~");
  const [path, setPath] = useState(projectsFolder);
  const [typed, setTyped] = useState(projectsFolder);
  const [listing, setListing] = useState<FolderList | null>(null);

  useEffect(() => {
    if (!isConnected) return;
    let isCurrent = true;
    setListing(null);
    void listFolders(host, path).then((result) => {
      if (!isCurrent) return;
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
      isCurrent = false;
    };
  }, [host, path, isConnected, onFolder]);

  if (!isConnected) {
    return (
      <p className="text-xs text-muted-foreground">
        {host} isn't isConnected yet. Its status is in Settings → Connections.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Parent folder"
          className="size-8 shrink-0 rounded-lg"
          disabled={!listing || listing.path === "/"}
          onClick={() => listing && setPath(getParentPath(listing.path))}
        >
          <ArrowUp className="size-4" />
        </Button>
        <Input
          aria-label={`Folder on ${host}`}
          value={typed}
          onChange={setTyped}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(event) => {
            if (event.key === "Enter" && typed.trim()) setPath(typed.trim());
          }}
          className="min-w-0 flex-1"
          classNames={{ field: "h-8 rounded-lg bg-background", input: "pl-2.5 font-mono text-xs" }}
        />
      </div>
      <ScrollArea className="h-56 rounded-xl border border-border bg-card">
        <FolderListing listing={listing} onOpen={setPath} />
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
        Add {listing && !listing.error ? getFolderName(listing.path) : "folder"}
      </Button>
    </div>
  );
}

function FolderListing({
  listing,
  onOpen,
}: {
  listing: FolderList | null;
  onOpen: (path: string) => void;
}) {
  if (!listing) {
    return (
      <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        Reading folders…
      </p>
    );
  }

  if (listing.error) return <p className="p-3 text-xs text-destructive">{listing.error}</p>;

  if (listing.folders.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No folders in here.</p>;
  }

  return (
    <div className="flex flex-col p-1">
      {listing.folders.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => onOpen(`${listing.path.replace(/\/$/, "")}/${name}`)}
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{name}</span>
        </button>
      ))}
    </div>
  );
}

/** Clones a repository into a new folder under `parent` and adds that as the project. */
function CloneRepository({ host, parent }: { host: string | null; parent: string | null }) {
  const [url, setUrl] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cloneRepository() {
    if (!parent || !url.trim() || isCloning) return;
    setIsCloning(true);
    setError(null);
    const cloned = await cloneProject(host, url.trim(), parent);
    setIsCloning(false);
    if (cloned.path) finishAddProject(cloned.path);
    else setError(cloned.error);
  }

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
          disabled={isCloning}
          onKeyDown={(event) => {
            if (event.key === "Enter") void cloneRepository();
          }}
          className="min-w-0 flex-1"
          classNames={{ field: "h-8 rounded-lg bg-background", input: "pl-2.5 font-mono text-xs" }}
        />
        <Button
          variant="secondary"
          className={cn("h-8 rounded-lg", isCloning && "pointer-events-none")}
          disabled={!parent || !url.trim() || isCloning}
          onClick={() => void cloneRepository()}
        >
          {isCloning ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {isCloning ? "Cloning…" : "Clone"}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
