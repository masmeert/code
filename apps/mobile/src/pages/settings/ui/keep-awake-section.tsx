import { formatClockTime, formatTimeLeft, useNow } from "@masscode/client";
import {
  ClientCommand,
  DEFAULT_KEEP_AWAKE_MANUAL_MINUTES,
  type KeepAwakeSettings,
} from "@masscode/contracts";
import { alertNotConnected, type HostState } from "@/entities/host";
import { send } from "@/shared/api";
import { FormButtonRow, FormInfoRow, FormSection, FormSwitchRow } from "@/shared/ui";

/** Keeping the computer awake for its agents: where it stands, and starting or stopping it from here. */
export function KeepAwakeSection({ host }: { host: HostState }) {
  const now = useNow(15_000);
  const { paired, keepAwake: status, settings } = host;
  const isConnected = host.connection === "connected";

  if (!status?.available || !settings) return null;

  const keepAwake = settings.keepAwake ?? { enabled: false };
  const minutes = keepAwake.manualMinutes ?? DEFAULT_KEEP_AWAKE_MANUAL_MINUTES;
  const { session } = status;

  function sendCommand(command: ClientCommand) {
    if (!send(paired.id, command)) alertNotConnected(paired.id);
  }

  function update(patch: Partial<KeepAwakeSettings>) {
    if (settings)
      sendCommand(
        ClientCommand.cases["settings.update"].make({
          settings: { ...settings, keepAwake: { ...keepAwake, ...patch } },
        }),
      );
  }

  return (
    <FormSection
      title="Keep awake"
      footer={
        isConnected
          ? (status.notice ??
            (status.access === "ready"
              ? `Agents keep working with ${paired.name}'s lid closed. Apps to pause are picked on the computer.`
              : `${paired.name} still sleeps when its lid closes. Set up lid-closed access in MassCode's settings there.`))
          : `Showing what ${paired.name} last said. You can change this once it's connected.`
      }
    >
      <FormSwitchRow
        label="Keep awake for agents"
        value={keepAwake.enabled}
        isDisabled={!isConnected}
        onChange={(enabled) => update({ enabled })}
      />
      {keepAwake.enabled ? (
        <>
          <FormSwitchRow
            label="While agents work"
            value={keepAwake.whileAgentsWork !== false}
            isDisabled={!isConnected}
            onChange={(whileAgentsWork) => update({ whileAgentsWork })}
          />
          <FormInfoRow
            label={
              !session
                ? "Not keeping awake right now"
                : session.reason === "manual"
                  ? `Awake until ${formatClockTime(session.endsAt)}`
                  : "Awake while agents work"
            }
            detail={
              session
                ? [
                    session.reason === "manual"
                      ? `${formatTimeLeft(session.endsAt - now)} left`
                      : `${formatClockTime(session.endsAt)} at the latest`,
                    status.lidClosed
                      ? `Lid closed${status.frozen.length > 0 ? `, ${status.frozen.map((app) => app.name).join(", ")} paused` : ""}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : undefined
            }
          />
          {session ? (
            <FormButtonRow
              label="Stop"
              isDestructive
              isDisabled={!isConnected}
              onPress={() => sendCommand(ClientCommand.cases["keepAwake.stop"].make({}))}
            />
          ) : (
            <FormButtonRow
              label={`Keep awake for ${formatTimeLeft(minutes * 60_000)}`}
              isDisabled={!isConnected}
              onPress={() => sendCommand(ClientCommand.cases["keepAwake.start"].make({ minutes }))}
            />
          )}
        </>
      ) : null}
    </FormSection>
  );
}
