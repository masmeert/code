import { Button } from "@masmeert/ui/button";
import { Input } from "@masmeert/ui/input";
import { cn } from "@masscode/ui/lib/utils";
import { ClientCommand, HostStatus, parsePairingLink, type RemoteHost } from "@masscode/contracts";
import { Collapsible } from "@masmeert/ui/collapsible";
import { ActionSwapRollText } from "@masscode/ui/motion/action-swap-roll";
import { IconLoader2, IconSearch } from "@tabler/icons-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { forgetFullAccessAsRoot, getHostState, useHostStore } from "@/entities/host";
import { scanProjects } from "@/entities/project";
import { getHostProjectsFolder, updateSettings, useSettings } from "@/entities/settings";
import { send } from "@/shared/api";
import { TextWithCode } from "@/shared/ui";
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  RowLabel,
  SettingsTextField,
} from "./settings-controls.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";

export function ConnectionsPage() {
  const hosts = useHostStore((state) => state.hosts);
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
        leftIcon={<IconSearch />}
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
          input: cn(typeClass("body", "compact"), "pl-9"),
        }}
      />
      <SettingsSection title="Remote hosts">
        {added.length ? (
          <SettingsGroup>
            {added.map(([name, host]) => (
              <HostRow
                key={name}
                alias={name}
                kind={host.kind}
                status={host.status}
                deviceId={host.deviceId}
              />
            ))}
          </SettingsGroup>
        ) : (
          <p className={cn(typeClass("caption"), "px-1 text-muted-foreground")}>
            {Object.keys(hosts).length
              ? "No host matches."
              : "None yet. A Linux machine runs agents while this Mac sleeps: pair one below, or add one over SSH above."}
          </p>
        )}
      </SettingsSection>
      <PairMachineSection />
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
                  size="compact"
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

const SETUP_COMMAND =
  "curl -fsSL https://github.com/masmeert/code/releases/latest/download/install.sh | sh && ~/.local/bin/masscode connect";

/** Pairs with a Linux machine set up with `masscode connect`, from the link or code it shows. */
function PairMachineSection() {
  const [target, setTarget] = useState("");
  const [code, setCode] = useState("");
  const [isPairing, setIsPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const isLink = parsePairingLink(target) !== null;

  const canPair =
    !isPairing && (isLink || (target.trim() !== "" && code.replace(/\D/g, "").length === 6));

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  async function copySetupCommand() {
    await navigator.clipboard?.writeText(SETUP_COMMAND);
    setIsCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setIsCopied(false), 1600);
  }

  async function pair() {
    if (!canPair || !window.desktop) return;

    setIsPairing(true);
    setError(null);

    const failure = await window.desktop.pairHost({ target, code: isLink ? "" : code });
    setIsPairing(false);
    setError(failure);

    if (failure === null) {
      setTarget("");
      setCode("");
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Enter") void pair();

    if (event.key === "Escape" && (target || code || error)) {
      event.stopPropagation();
      setTarget("");
      setCode("");
      setError(null);
    }
  }

  return (
    <SettingsSection title="Pair a machine">
      <SettingsGroup>
        <SettingsRow
          label={
            <RowLabel
              title="1. Set it up"
              description="Run this on the Linux machine, with Tailscale on. It installs MassCode and shows a pairing link."
            />
          }
        >
          <Button
            size="compact"
            variant="secondary"
            className="h-7 rounded-lg"
            onClick={() => void copySetupCommand()}
          >
            <ActionSwapRollText value={isCopied ? "copied" : "idle"}>
              {isCopied ? "Copied" : "Copy command"}
            </ActionSwapRollText>
          </Button>
        </SettingsRow>
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <RowLabel
            title="2. Pair"
            description="Paste that link, or type the machine's Tailscale name and its code."
          />
          <div className="flex items-center gap-2">
            <Input
              aria-label="Pairing link or machine name"
              value={target}
              onChange={(value) => {
                setTarget(value);
                setError(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="masscode://pair?… or nuc"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1"
              classNames={{
                field: "h-8 rounded-lg bg-background",
                input: cn(typeClass("body", "compact"), "font-mono"),
              }}
            />
            {isLink ? null : (
              <Input
                aria-label="Pairing code"
                value={code}
                onChange={(value) => {
                  setCode(value.replace(/[^\d ]/g, "").slice(0, 7));
                  setError(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder="123 456"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="w-24"
                classNames={{
                  field: "h-8 rounded-lg bg-background",
                  input: cn(typeClass("body", "compact"), "font-mono tabular-nums"),
                }}
              />
            )}
            <Button
              size="compact"
              variant="secondary"
              aria-label="Pair"
              className="h-8 min-w-14 rounded-lg"
              disabled={!canPair}
              onClick={() => void pair()}
            >
              {isPairing ? <IconLoader2 className="size-3.5 animate-spin" /> : "Pair"}
            </Button>
          </div>
        </div>
        <Collapsible open={error !== null}>
          <p className={cn(typeClass("caption"), "px-3 py-2.5 text-destructive")}>{error}</p>
        </Collapsible>
      </SettingsGroup>
    </SettingsSection>
  );
}

function HostRow({
  alias,
  kind,
  status,
  deviceId,
}: {
  alias: string;
  kind: RemoteHost["kind"];
  status: HostStatus;
  deviceId: string | null;
}) {
  const [confirmingAction, setConfirmingAction] = useState<"remove" | "restart" | null>(null);
  const settings = useSettings();
  const isConfirming = confirmingAction !== null;

  return (
    <>
      <SettingsRow
        label={
          <div className="min-w-0">
            <p className={cn(typeClass("body", "compact"), "font-mono")}>
              {alias}
              <span className="ml-2 font-sans text-muted-foreground">
                {kind === "paired" ? "Paired" : "SSH"}
              </span>
            </p>
            <div
              className={cn(typeClass("caption"), "flex items-start gap-1.5 text-muted-foreground")}
            >
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
                  connecting: ({ step }): ReactNode => `${step}…`,
                  connected: () => "Connected",
                  updating: () => "Update ready. Restarts once its running turns end",
                  // Paired hosts' messages are written for people; SSH's come straight from ssh.
                  failed: ({ message }): ReactNode =>
                    kind === "paired" ? (
                      <TextWithCode text={message} />
                    ) : (
                      <>
                        <TextWithCode
                          text={`Couldn't connect to ${alias}. Check that \`ssh ${alias}\` works in a terminal, then Retry.`}
                        />
                        <span className="mt-0.5 block selectable font-mono text-muted-foreground">
                          {message}
                        </span>
                      </>
                    ),
                })}
              </span>
            </div>
          </div>
        }
      >
        {isConfirming ? (
          <div className="flex items-center gap-1">
            <Button
              size="compact"
              variant="ghost"
              className="h-7 rounded-lg"
              onClick={() => setConfirmingAction(null)}
            >
              Cancel
            </Button>
            <Button
              size="compact"
              variant="ghost"
              className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
              onClick={() => {
                setConfirmingAction(null);

                if (confirmingAction === "remove") {
                  forgetFullAccessAsRoot(alias);

                  // Revokes this Mac's token there too, when it can still be reached.
                  if (deviceId)
                    send(ClientCommand.cases["phone.unpair"].make({ phoneId: deviceId }), alias);

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
                size="compact"
                variant="secondary"
                className="h-7 rounded-lg"
                onClick={() => void window.desktop?.hostDaemon(alias)}
              >
                Retry
              </Button>
            ) : null}
            {HostStatus.guards.updating(status) ? (
              <Button
                size="compact"
                variant="secondary"
                className="h-7 rounded-lg"
                onClick={() => setConfirmingAction("restart")}
              >
                Restart now
              </Button>
            ) : null}
            <Button
              size="compact"
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
        <p className={cn(typeClass("caption"), "px-3 py-2.5 text-muted-foreground")}>
          <TextWithCode
            text={
              confirmingAction === "remove"
                ? kind === "paired"
                  ? `This unpairs this Mac from ${alias}. MassCode keeps running there with its threads; run \`masscode pair\` on it to pair again.`
                  : `This stops MassCode on ${alias}, and any agents working there. Its threads stay on ${alias} for when you add it again.`
                : `This stops the turns running on ${alias} and restarts it on this version.`
            }
          />
        </p>
      ) : null}
      <SettingsRow
        label={
          <RowLabel
            title="Projects folder"
            description="Its git repos become projects, and clones go here"
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

            // Until this Mac's shell or cache is in, its settings don't say where that folder is.
            if (getHostState().source !== "none") scanProjects(alias, getHostProjectsFolder(alias));
          }}
        />
      </SettingsRow>
    </>
  );
}
