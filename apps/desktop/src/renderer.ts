import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_DAEMON_PORT } from "@apcode/contracts";
import { app, net, protocol, session } from "electron";

export const APP_URL = app.isPackaged ? "app://apcode/" : "http://localhost:1420/";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval'${app.isPackaged ? "" : " 'unsafe-inline'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: http: https:",
  "frame-src http: https:",
  `connect-src 'self' ws://127.0.0.1:${DEFAULT_DAEMON_PORT}${app.isPackaged ? "" : " ws://localhost:1420"}`,
].join("; ");

export function registerRendererScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function serveRenderer() {
  if (!app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: [`${APP_URL}*`] },
      (details, callback) =>
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
          },
        }),
    );
    return;
  }
  protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const response = await net.fetch(
      pathToFileURL(
        join(process.resourcesPath, "renderer", pathname === "/" ? "index.html" : pathname),
      ).toString(),
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/octet-stream",
        "content-security-policy": CONTENT_SECURITY_POLICY,
      },
    });
  });
}
