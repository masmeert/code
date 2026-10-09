import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";

/** Per launch, so a restart revokes every URL handed out. */
const SIGNING_KEY = randomBytes(32);

export const ASSET_ROUTE_PREFIX = "/assets/";

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
]);

interface AssetClaims {
  readonly path: string;
  /** Device and inode at signing, so swapping another file in at the path doesn't serve it. */
  readonly device: string;
  readonly inode: string;
  readonly expiresAt: number;
}

function computeSignature(payload: string) {
  return createHmac("sha256", SIGNING_KEY).update(payload).digest("base64url");
}

/** A URL path serving the image at `path` (relative to `cwd`, `~` for home) for an hour; null for anything else. */
export async function signImage(path: string, cwd: string) {
  const absolute = resolve(cwd, path.replace(/^~(?=\/|$)/, homedir()));
  if (!IMAGE_TYPES.has(extname(absolute).toLowerCase())) return null;

  const file = await stat(absolute, { bigint: true }).catch(() => null);
  if (!file?.isFile()) return null;

  const payload = Buffer.from(
    JSON.stringify({
      path: absolute,
      device: String(file.dev),
      inode: String(file.ino),
      expiresAt: Date.now() + 60 * 60 * 1000,
    } satisfies AssetClaims),
  ).toString("base64url");

  return `${ASSET_ROUTE_PREFIX}${payload}.${computeSignature(payload)}`;
}

/** Serves a URL from `signImage`; the token is the only credential, so it skips the origin and daemon-token checks. */
export async function serveAsset(token: string) {
  const [payload = "", given = ""] = token.split(".");
  const expected = Buffer.from(computeSignature(payload));
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), expected))
    return new Response("Not found", { status: 404 });

  // SAFETY: signed by this process from an AssetClaims.
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as AssetClaims;
  if (claims.expiresAt < Date.now()) return new Response("Expired", { status: 410 });

  const file = await stat(claims.path, { bigint: true }).catch(() => null);
  if (!file || String(file.dev) !== claims.device || String(file.ino) !== claims.inode)
    return new Response("Not found", { status: 404 });

  return new Response(Bun.file(claims.path), {
    headers: {
      "content-type":
        IMAGE_TYPES.get(extname(claims.path).toLowerCase()) ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      // An SVG opened directly would otherwise run its scripts on the daemon's origin.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
