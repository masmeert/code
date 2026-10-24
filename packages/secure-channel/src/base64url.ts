/** Short binary values (keys, nonces, signatures) as URL-safe text, using only what Bun, Workers and Hermes share. */
export function encodeBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Null for text that isn't base64url. */
export function decodeBase64Url(text: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;

  try {
    return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}
