import { ClientCommand } from "@masscode/contracts";
import { sendRequest } from "@/shared/api";

/** A one-time code for a phone to pair with this Mac, or why it can't pair. */
export async function startPhonePairing() {
  const started = await sendRequest(
    null,
    ClientCommand.cases["pairing.start"].make({ requestId: crypto.randomUUID() }),
    "pairing.started",
    10_000,
  );

  return started ?? { offer: null, error: "MassCode didn't answer in time. Try again." };
}
