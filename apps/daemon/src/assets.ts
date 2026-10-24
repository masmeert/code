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

/** Phones on the relay get files inline in a frame, so this many bytes at most. */
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

/** The file a token from `signImage` still names: unexpired, and the very file that was signed. */
async function verifyAsset(token: string) {
  const [payload = "", given = ""] = token.split(".");
  const expected = Buffer.from(computeSignature(payload));

  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), expected))
    return { error: 404 } as const;

  // SAFETY: signed by this process from an AssetClaims.
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as AssetClaims;

  if (claims.expiresAt < Date.now()) return { error: 410 } as const;

  const file = await stat(claims.path, { bigint: true }).catch(() => null);

  if (!file || String(file.dev) !== claims.device || String(file.ino) !== claims.inode)
    return { error: 404 } as const;

  return {
    path: claims.path,
    size: Number(file.size),
    mediaType: IMAGE_TYPES.get(extname(claims.path).toLowerCase()) ?? "application/octet-stream",
  };
}

/** Serves a URL from `signImage`; the token is the only credential, so it skips the origin and daemon-token checks. */
export async function serveAsset(token: string) {
  const asset = await verifyAsset(token);

  if ("error" in asset)
    return new Response(asset.error === 410 ? "Expired" : "Not found", { status: asset.error });

  return new Response(Bun.file(asset.path), {
    headers: {
      "content-type": asset.mediaType,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      // An SVG opened directly would otherwise run its scripts on the daemon's origin.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

/**
 * A URL from `signImage` as base64, for phones on the relay, which can't load it over HTTP; null
 * once it's expired, the file changed, or it's too large to send inline.
 */
export async function readAsset(url: string) {
  if (!url.startsWith(ASSET_ROUTE_PREFIX)) return null;

  const asset = await verifyAsset(url.slice(ASSET_ROUTE_PREFIX.length));

  if ("error" in asset || asset.size > MAX_INLINE_BYTES) return null;

  return {
    mediaType: asset.mediaType,
    data: Buffer.from(await Bun.file(asset.path).arrayBuffer()).toString("base64"),
  };
}
