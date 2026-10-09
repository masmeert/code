import { Button } from "@masscode/ui/motion/button/base";
import { Input } from "@masscode/ui/motion/input";
import { cn } from "@masscode/ui/lib/utils";
import { HostStatus } from "@masscode/contracts";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { forgetFullAccessAsRoot } from "../../lib/composer.ts";
import { scanProjects, updateSettings, useStore } from "../../lib/store.ts";
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  RowLabel,
  SettingsTextField,
} from "./SettingsControls.tsx";

export function ConnectionsPage() {
  const hosts = useStore((state) => state.hosts);
  const [query, setQuery] = useState("");
  const [aliases, setAliases] = useState<ReadonlyArray<string>>([]);

  // Unreadable ~/.ssh/config just means no suggestions; a typed address still works.
  useEffect(() => void window.desktop?.sshAliases().then(setAliases, () => {}), []);

  const typed = query.trim();

  function isMatchingQuery(name: string) {
    return name.toLowerCase().includes(typed.toLowerCase());
  }

  const added = Object.entries(hosts).filter(([name]) => isMatchingQuery(name));

  // Configs can list dozens, so they show once there's a search, or while there's no host yet.
  const suggestions =
    typed || Object.keys(hosts).length === 0
      ? aliases.filter((name) => !hosts[name] && isMatchingQuery(name))
      : [];

  // What's typed is a host of its own, like me@server, when it isn't the start of a listed one.
  const addable = [
    ...(typed && !hosts[typed] && suggestions.length === 0 && !/\s/.test(typed) ? [typed] : []),
    ...suggestions,
  ];

  function addHost(alias: string) {
    void window.desktop?.addHost(alias);
    setQuery("");
  }

  return (
    <>
      <Input
        aria-label="Search or add an SSH host"
        value={query}
        onChange={setQuery}
        placeholder="Search or add an SSH host, like devbox or me@server"
        spellCheck={false}
        autoComplete="off"
        leftIcon={<Search />}
        onKeyDown={(event) => {
          if (event.key === "Enter" && addable.length === 1) addHost(addable[0]);

          if (event.key === "Escape" && query) {
            event.stopPropagation();
            setQuery("");
          }
        }}
        className="mb-5"
        classNames={{
          field: "h-9 rounded-lg bg-background",
          leftIcon: "left-2.5",
          input: "pl-9 text-[13px]",
        }}
      />
      <SettingsSection title="Remote hosts">
        {added.length ? (
          <SettingsGroup>
            {added.map(([name, host]) => (
              <HostRow key={name} alias={name} status={host.status} />
            ))}
          </SettingsGroup>
        ) : (
          <p className="px-1 text-xs text-muted-foreground">
            {Object.keys(hosts).length
              ? "No host matches."
              : "None yet. A Linux host runs agents over SSH while this Mac sleeps."}
          </p>
        )}
      </SettingsSection>
      {addable.length ? (
        <SettingsSection title="Add host">
          <SettingsGroup>
            {addable.map((alias) => (
              <SettingsRow
                key={alias}
                label={
                  <RowLabel
                    title={alias}
                    description={aliases.includes(alias) ? "In ~/.ssh/config" : "Typed address"}
                  />
                }
              >
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 rounded-lg"
                  onClick={() => addHost(alias)}
                >
                  Add
                </Button>
              </SettingsRow>
            ))}
          </SettingsGroup>
        </SettingsSection>
      ) : null}
    </>
  );
}

function HostRow({ alias, status }: { alias: string; status: HostStatus }) {
  const [confirmingAction, setConfirmingAction] = useState<"remove" | "restart" | null>(null);
  const settings = useStore((state) => state.settings);
  const isConfirming = confirmingAction !== null;

  return (
    <>
      <SettingsRow
        label={
          <div className="min-w-0">
            <p className="font-mono text-[13px]">{alias}</p>
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  HostStatus.match(status, {
                    connecting: () => "bg-warning",
                    connected: () => "bg-success",
                    updating: () => "bg-warning",
                    failed: () => "bg-destructive",
                  }),
                )}
              />
              <span
                className={cn("min-w-0", HostStatus.guards.failed(status) && "text-destructive")}
              >
                {HostStatus.match(status, {
                  connecting: ({ step }) => `${step}…`,
                  connected: () => "Connected",
                  updating: () => "Updating: the new version starts once its running turns end",
                  failed: ({ message }) => message,
                })}
              </span>
            </div>
          </div>
        }
      >
        {isConfirming ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-lg"
              onClick={() => setConfirmingAction(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
              onClick={() => {
                setConfirmingAction(null);

                if (confirmingAction === "remove") {
                  forgetFullAccessAsRoot(alias);
                  void window.desktop?.removeHost(alias);
                } else void window.desktop?.restartHost(alias);
              }}
            >
              {confirmingAction === "remove" ? "Remove" : "Restart now"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {HostStatus.guards.failed(status) ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-lg"
                onClick={() => void window.desktop?.hostDaemon(alias)}
              >
                Retry
              </Button>
            ) : null}
            {HostStatus.guards.updating(status) ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-lg"
                onClick={() => setConfirmingAction("restart")}
              >
                Restart now
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-lg"
              onClick={() => setConfirmingAction("remove")}
            >
              Remove
            </Button>
          </div>
        )}
      </SettingsRow>
      {isConfirming ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          {confirmingAction === "remove"
            ? `This stops MassCode on ${alias}, and any agents working there. Its threads stay on ${alias} for when you add it again.`
            : `This stops the turns running on ${alias} and restarts it on this version.`}
        </p>
      ) : null}
      <SettingsRow
        label={
          <RowLabel
            title="Projects folder"
            description={`Git repos in it are added as projects on ${alias}, and clones go there`}
          />
        }
      >
        <SettingsTextField
          label={`Projects folder on ${alias}`}
          isMonospace
          value={settings.hostProjectFolders?.[alias] ?? ""}
          placeholder="~"
          onCommit={(folder) => {
            updateSettings({
              ...settings,
              hostProjectFolders: { ...settings.hostProjectFolders, [alias]: folder },
            });
            scanProjects(alias);
          }}
        />
      </SettingsRow>
    </>
  );
}
