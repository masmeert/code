import { ClientCommand } from "@masscode/contracts";
import { sendRequest } from "@/shared/api";

/** This Mac's simulators and its device hub, setting the tools up first with `install`; null when the daemon doesn't answer. */
export function listDevices(install: boolean) {
  return sendRequest(
    null,
    ClientCommand.cases["device.list"].make({ install, requestId: crypto.randomUUID() }),
    "device.listed",
    // Setting up installs two npm packages.
    install ? 10 * 60_000 : 60_000,
  );
}

/** Boots a simulator if needed and shows it in the thread's panel; resolves to an error message, or null. */
export async function attachDevice(threadId: string, deviceId: string | null) {
  const attached = await sendRequest(
    null,
    ClientCommand.cases["device.attach"].make({
      threadId,
      deviceId,
      requestId: crypto.randomUUID(),
    }),
    "device.attached",
    3 * 60_000,
  );

  return attached ? attached.error : "MassCode didn't answer in time. Try again.";
}
