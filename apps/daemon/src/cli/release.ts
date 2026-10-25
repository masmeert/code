import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BIN_DIR, CliError } from "./service.ts";

const RELEASES_URL = "https://github.com/masmeert/code/releases";

async function fetchOrFail(url: string, what: string) {
  const response = await fetch(url).catch(() => null);

  if (!response?.ok)
    throw new CliError(
      `Couldn't download ${what} (${response ? `${response.status} from GitHub` : "no connection"}). Check this machine's internet connection, then retry.`,
    );

  return response;
}

/** The newest published release's version, from where GitHub's `latest` redirects. */
async function findLatestVersion() {
  const response = await fetch(`${RELEASES_URL}/latest`, { redirect: "manual" }).catch(() => null);
  const version = response?.headers.get("location")?.match(/\/tag\/v([\w.-]+)$/)?.[1];

  if (!version)
    throw new CliError(
      "Couldn't find MassCode's latest release on GitHub. Check this machine's internet connection, then retry.",
    );

  return version;
}

/**
 * Downloads `version` (the latest when null), checks it against the release's SHA256SUMS and
 * makes it the one `masscode` runs. Returns the version installed.
 */
export async function installRelease(version: string | null) {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : null;

  if (!arch)
    throw new CliError(`MassCode runs on x64 and arm64 Linux; this machine is ${process.arch}.`);

  const target = version ?? (await findLatestVersion());
  const asset = `masscode-daemon-linux-${arch}.gz`;
  const releaseUrl = `${RELEASES_URL}/download/v${target}`;

  const sums = await (
    await fetchOrFail(`${releaseUrl}/SHA256SUMS`, `MassCode ${target}'s checksums`)
  ).text();

  const expected = sums.match(
    new RegExp(`^([0-9a-f]{64})\\s+\\*?${asset.replaceAll(".", "\\.")}$`, "m"),
  )?.[1];

  if (!expected) throw new CliError(`MassCode ${target} has no build for ${arch} Linux.`);

  const archive = new Uint8Array(
    await (await fetchOrFail(`${releaseUrl}/${asset}`, `MassCode ${target}`)).arrayBuffer(),
  );

  if (createHash("sha256").update(archive).digest("hex") !== expected)
    throw new CliError(
      `The download of MassCode ${target} doesn't match its checksum, so it wasn't installed. Retry; if it keeps failing, report it.`,
    );

  const binary = join(BIN_DIR, `masscode-${target}`);

  await mkdir(BIN_DIR, { recursive: true });
  await writeFile(`${binary}.download`, Bun.gunzipSync(archive));
  await chmod(`${binary}.download`, 0o755);
  await rename(`${binary}.download`, binary);

  // Swapped in one rename, so the service never sees `masscode` missing.
  const link = join(BIN_DIR, "masscode");
  await rm(`${link}.next`, { force: true });
  await symlink(`masscode-${target}`, `${link}.next`);
  await rename(`${link}.next`, link);

  for (const file of await readdir(BIN_DIR))
    if (file.startsWith("masscode-") && file !== `masscode-${target}`)
      await rm(join(BIN_DIR, file), { force: true });

  return target;
}
