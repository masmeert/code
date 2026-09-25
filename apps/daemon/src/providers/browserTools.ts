import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { BrowserAction, BrowserResult } from "@apcode/contracts";
import { z } from "zod";

export function browserTools(browser: (action: BrowserAction) => Promise<BrowserResult>) {
  async function run(action: BrowserAction) {
    try {
      const result = await browser(action);
      return {
        content: [
          { type: "text" as const, text: `${result.title || "(untitled)"} — ${result.url}\n\n${result.text}` },
          ...(result.screenshot ? [{ type: "image" as const, data: result.screenshot, mimeType: "image/png" }] : []),
        ],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }

  return createSdkMcpServer({
    name: "browser",
    instructions:
      "A real browser the user watches in APCode's Browser panel next to this thread; it shares their logins. Use it to check web apps you build (such as a local dev server) or to read pages. Call snapshot to see the page (text, interactive elements with refs like e3, and a screenshot), then click or type by ref. Refs go stale after navigation or re-renders, so take a new snapshot when an action says nothing matches.",
    tools: [
      tool(
        "navigate",
        "Open a URL in the browser; localhost addresses need no scheme. Opens the Browser panel if it's closed.",
        { url: z.string() },
        ({ url }) => run({ _tag: "navigate", url }),
        { alwaysLoad: true },
      ),
      tool(
        "snapshot",
        "See the current page: URL, title, visible text, interactive elements with refs, and a screenshot.",
        {},
        () => run({ _tag: "snapshot" }),
        { alwaysLoad: true },
      ),
      tool(
        "click",
        "Click an element by ref from the latest snapshot (such as e3) or by CSS selector.",
        { target: z.string() },
        ({ target }) => run({ _tag: "click", target }),
        { alwaysLoad: true },
      ),
      tool(
        "type",
        "Replace the text of an input by ref or CSS selector; set submit to press Enter afterwards.",
        { target: z.string(), text: z.string(), submit: z.boolean().optional() },
        ({ target, text, submit }) => run({ _tag: "type", target, text, submit: submit ?? false }),
        { alwaysLoad: true },
      ),
      tool(
        "press",
        "Press a key in the page, such as Enter, Tab, Escape, Backspace or ArrowDown.",
        { key: z.string() },
        ({ key }) => run({ _tag: "press", key }),
        { alwaysLoad: true },
      ),
      tool(
        "evaluate",
        "Run a JavaScript expression in the page and return its JSON value.",
        { expression: z.string() },
        ({ expression }) => run({ _tag: "evaluate", expression }),
        { alwaysLoad: true },
      ),
      tool("console", "Read the page's recent console messages and errors.", {}, () => run({ _tag: "console" }), { alwaysLoad: true }),
    ],
  });
}
