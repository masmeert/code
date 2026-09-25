import { Script } from "node:vm";
import { BrowserAction, type BrowserResult } from "@apcode/contracts";
import { type BrowserWindow, type WebContents, webContents } from "electron";

const consoleLines = new Map<number, Array<string>>();

export function recordConsole(guest: WebContents) {
  const lines: Array<string> = [];
  consoleLines.set(guest.id, lines);
  guest.on("console-message", (details) => {
    if (details.message.startsWith("%cElectron Security Warning")) return;
    lines.push(`[${details.level}] ${details.message}`);
    if (lines.length > 100) lines.shift();
  });
  guest.once("destroyed", () => consoleLines.delete(guest.id));
}

function snapshotPage() {
  const roles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "textbox",
    "searchbox",
    "combobox",
    "slider",
    "spinbutton",
    "treeitem",
  ]);
  const implicitRole = new Map([
    ["A", "link"],
    ["BUTTON", "button"],
    ["TEXTAREA", "textbox"],
    ["SELECT", "combobox"],
    ["SUMMARY", "button"],
  ]);
  for (const element of document.querySelectorAll("[data-apcode-ref]"))
    element.removeAttribute("data-apcode-ref");
  const lines: Array<string> = [];
  for (const element of document.querySelectorAll<HTMLElement>(
    'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  )) {
    const inputType = element instanceof HTMLInputElement ? element.type : "";
    const role =
      element.getAttribute("role") ??
      (inputType === "checkbox" || inputType === "radio"
        ? inputType
        : inputType === "submit" || inputType === "button"
          ? "button"
          : null) ??
      (inputType
        ? "textbox"
        : (implicitRole.get(element.tagName) ??
          (element.isContentEditable ? "textbox" : "generic")));
    if (element.hasAttribute("role") && !roles.has(role)) continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      rect.width === 0 ||
      rect.height === 0 ||
      style.visibility === "hidden" ||
      element.closest('[aria-hidden="true"]')
    )
      continue;
    if (lines.length === 200) break;
    const ref = `e${lines.length + 1}`;
    element.setAttribute("data-apcode-ref", ref);
    const value =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : "";
    const name = (
      element.getAttribute("aria-label") ??
      (element.innerText ||
        element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        element.getAttribute("alt") ||
        "")
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const href = element instanceof HTMLAnchorElement ? ` -> ${element.getAttribute("href")}` : "";
    const current = value && role === "textbox" ? ` value="${value.slice(0, 60)}"` : "";
    const checked =
      element instanceof HTMLInputElement && (inputType === "checkbox" || inputType === "radio")
        ? element.checked
          ? " checked"
          : " unchecked"
        : "";
    const offscreen = rect.bottom < 0 || rect.top > innerHeight ? " (offscreen)" : "";
    lines.push(`${ref} ${role} "${name}"${href}${current}${checked}${offscreen}`);
  }
  const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return [
    `Viewport ${innerWidth}x${innerHeight}, scrolled to ${Math.round(scrollY)} of ${document.documentElement.scrollHeight}.`,
    "",
    "Interactive elements (pass the ref, e.g. e3, as target):",
    ...(lines.length ? lines : ["(none)"]),
    "",
    "Page text:",
    text.length > 8000
      ? `${text.slice(0, 8000)}\n… (${text.length - 8000} more characters; use evaluate to read the rest)`
      : text || "(empty)",
  ].join("\n");
}

function targetElement(purpose: "point" | "focus", target: string) {
  let element: Element | null;
  try {
    element = /^e\d+$/.test(target)
      ? document.querySelector(`[data-apcode-ref="${target}"]`)
      : document.querySelector(target);
  } catch {
    return { error: `${target} isn't a ref or a valid CSS selector` };
  }
  if (!(element instanceof HTMLElement))
    return { error: `Nothing matches ${target}; take a new snapshot for current refs` };
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (purpose === "focus") {
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      element.select();
    else if (element.isContentEditable) document.execCommand("selectAll");
    return { x: 0, y: 0 };
  }
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}

function isExpression(source: string) {
  try {
    new Script(`(async () => (${source}\n))`);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<A>(promise: Promise<A>, milliseconds: number, message: string) {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(message)), milliseconds),
    ),
  ]);
}

async function settle(guest: WebContents, milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!guest.isLoading()) return;
  await withTimeout(
    new Promise<void>((resolve) => guest.once("did-stop-loading", () => resolve())),
    milliseconds,
    "",
  ).catch(() => {});
}

async function capture(guest: WebContents) {
  try {
    const image = await withTimeout(guest.capturePage(), 5000, "Screenshot timed out");
    if (image.isEmpty()) return null;
    return (image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image)
      .toPNG()
      .toString("base64");
  } catch {
    return null;
  }
}

function pressKey(guest: WebContents, key: string) {
  const keyCode = key.startsWith("Arrow") ? key.slice(5) : key;
  guest.sendInputEvent({ type: "keyDown", keyCode });
  if (keyCode === "Enter") guest.sendInputEvent({ type: "char", keyCode: "\r" });
  else if (keyCode.length === 1) guest.sendInputEvent({ type: "char", keyCode });
  guest.sendInputEvent({ type: "keyUp", keyCode });
}

function run(guest: WebContents, action: BrowserAction): Promise<string> {
  return BrowserAction.match(action, {
    navigate: async ({ url }) => {
      await withTimeout(guest.loadURL(url), 30_000, `Timed out loading ${url}`).catch(
        (cause: unknown) => {
          if (!String(cause).includes("ERR_ABORTED")) throw cause;
        },
      );
      return `Loaded ${guest.getURL()}`;
    },
    status: async () => {
      await settle(guest, 30_000);
      return guest.isLoading() ? "Still loading" : `Loaded ${guest.getURL()}`;
    },
    snapshot: () => guest.executeJavaScript(`(${snapshotPage.toString()})()`, true),
    click: async ({ target }) => {
      const point = await guest.executeJavaScript(
        `(${targetElement.toString()})("point", ${JSON.stringify(target)})`,
        true,
      );
      if ("error" in point) throw new Error(point.error);
      guest.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
      guest.sendInputEvent({
        type: "mouseDown",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      guest.sendInputEvent({
        type: "mouseUp",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await settle(guest, 10_000);
      return `Clicked ${target}`;
    },
    type: async ({ target, text, submit }) => {
      const focused = await guest.executeJavaScript(
        `(${targetElement.toString()})("focus", ${JSON.stringify(target)})`,
        true,
      );
      if ("error" in focused) throw new Error(focused.error);
      await guest.insertText(text);
      if (submit) pressKey(guest, "Enter");
      await settle(guest, 10_000);
      return `Typed into ${target}${submit ? " and pressed Enter" : ""}`;
    },
    press: async ({ key }) => {
      pressKey(guest, key);
      await settle(guest, 10_000);
      return `Pressed ${key}`;
    },
    evaluate: async ({ expression }) => {
      const outcome: { value?: unknown; error?: string } = isExpression(expression)
        ? await guest.executeJavaScript(
            `(async () => { try { return { value: await (${expression}\n) }; } catch (error) { return { error: String(error instanceof Error ? (error.stack ?? error.message) : error) }; } })()`,
            true,
          )
        : { value: await guest.executeJavaScript(expression, true) };
      if (outcome.error !== undefined) throw new Error(outcome.error);
      return (JSON.stringify(outcome.value, null, 2) ?? "undefined").slice(0, 20_000);
    },
    console: async () => consoleLines.get(guest.id)?.join("\n") || "No console messages yet",
  });
}

export async function automateBrowser(
  window: BrowserWindow,
  webContentsId: number,
  action: BrowserAction,
): Promise<BrowserResult> {
  const guest = webContents.fromId(webContentsId);
  if (
    !guest ||
    guest.isDestroyed() ||
    guest.getType() !== "webview" ||
    guest.hostWebContents !== window.webContents
  ) {
    throw new Error("That browser tab isn't open in this window");
  }
  const text = await run(guest, action);
  return {
    url: guest.getURL(),
    title: guest.getTitle(),
    text,
    screenshot: BrowserAction.guards.snapshot(action) ? await capture(guest) : null,
  };
}
