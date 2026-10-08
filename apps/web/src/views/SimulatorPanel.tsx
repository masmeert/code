import type { Device, DeviceHub } from "@masscode/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@masscode/ui/components/dropdown-menu";
import { ResizeHandle } from "@masscode/ui/components/resize-handle";
import { useResizable } from "@masscode/ui/hooks/use-resizable";
import { ChevronDown, House, LoaderCircle, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { IconButton } from "../components/icon-button.tsx";
import { Message } from "./BrowserPanel.tsx";
import { toggleSimulator, useSimulator } from "../lib/simulator.ts";
import { attachDevice, listDevices } from "../lib/store.ts";

type Setup =
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | { readonly status: "installing" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly hub: DeviceHub; readonly devices: ReadonlyArray<Device> };

/** serve-sim's input socket: one tag byte, then JSON. Tags and HID usages ported from t3code (MIT). */
const TOUCH = 0x03;
const BUTTON = 0x04;
const KEY = 0x06;

type Input =
  | {
      readonly tag: typeof TOUCH;
      readonly type: "begin" | "move" | "end";
      readonly x: number;
      readonly y: number;
    }
  | { readonly tag: typeof BUTTON; readonly button: "home" }
  | { readonly tag: typeof KEY; readonly type: "down" | "up"; readonly usage: number };

const HID_USAGE_BY_CODE = new Map([
  ["Enter", 0x28],
  ["Escape", 0x29],
  ["Backspace", 0x2a],
  ["Tab", 0x2b],
  ["Space", 0x2c],
  ["Minus", 0x2d],
  ["Equal", 0x2e],
  ["BracketLeft", 0x2f],
  ["BracketRight", 0x30],
  ["Backslash", 0x31],
  ["Semicolon", 0x33],
  ["Quote", 0x34],
  ["Backquote", 0x35],
  ["Comma", 0x36],
  ["Period", 0x37],
  ["Slash", 0x38],
  ["Delete", 0x4c],
  ["ArrowRight", 0x4f],
  ["ArrowLeft", 0x50],
  ["ArrowDown", 0x51],
  ["ArrowUp", 0x52],
  ["ControlLeft", 0xe0],
  ["ShiftLeft", 0xe1],
  ["AltLeft", 0xe2],
  ["ControlRight", 0xe4],
  ["ShiftRight", 0xe5],
  ["AltRight", 0xe6],
]);

function hidUsage(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + code.charCodeAt(3) - 65;
  if (/^Digit[1-9]$/.test(code)) return 0x1e + code.charCodeAt(5) - 49;
  if (code === "Digit0") return 0x27;
  return HID_USAGE_BY_CODE.get(code) ?? null;
}

export function SimulatorPanel({ threadId }: { threadId: string }) {
  const { deviceId } = useSimulator(threadId);
  const aside = useRef<HTMLElement>(null);
  const panel = useResizable({
    key: "masscode.simulatorPanelWidth",
    initial: 400,
    side: "start",
    clamp: (width) =>
      Math.max(
        280,
        Math.min(width, (aside.current?.parentElement?.clientWidth ?? window.innerWidth) - 380),
      ),
  });
  const [setup, setSetup] = useState<Setup>({ status: "loading" });
  const [booting, setBooting] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  async function load(install: boolean) {
    setSetup({ status: install ? "installing" : "loading" });
    const listed = await listDevices(install);
    if (!listed)
      return setSetup({ status: "failed", message: "MassCode didn't answer. Try again." });
    if (listed.error) return setSetup({ status: "failed", message: listed.error });
    if (!listed.hub) return setSetup({ status: "missing" });
    setSetup({ status: "ready", hub: listed.hub, devices: listed.devices });
    // The hub forgets its streams when it restarts, so reattach the thread's simulator.
    if (deviceId) void boot(deviceId);
  }

  async function boot(id: string) {
    setBooting(id);
    setBootError(null);
    const error = await attachDevice(threadId, id);
    setBooting(null);
    setBootError(error);
  }

  const loadOnOpen = useEffectEvent(() => void load(false));
  useEffect(() => loadOnOpen(), []);

  const devices = setup.status === "ready" ? setup.devices : [];
  const device = devices.find((candidate) => candidate.id === deviceId);

  return (
    <aside
      ref={aside}
      aria-label="iOS Simulator"
      style={{ width: panel.width }}
      className="relative flex min-h-0 min-w-70 shrink flex-col border-l border-border bg-background"
    >
      <ResizeHandle
        side="start"
        label="Resize simulator"
        value={panel.width}
        dragging={panel.dragging}
        {...panel.handleProps}
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={setup.status !== "ready"}
            className="flex h-7 min-w-0 items-center gap-1 rounded-lg px-2 text-xs text-foreground transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            <span className="truncate">{device?.name ?? "Choose a simulator"}</span>
            {device ? <span className="text-muted-foreground">{device.version}</span> : null}
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            collisionPadding={8}
            className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto"
          >
            <DropdownMenuRadioGroup value={deviceId ?? ""} onValueChange={(id) => void boot(id)}>
              {devices.map((candidate) => (
                <DropdownMenuRadioItem key={candidate.id} value={candidate.id}>
                  <span className="truncate">{candidate.name}</span>
                  <span className="ml-auto pl-4 text-muted-foreground">
                    {candidate.version}
                    {candidate.booted ? " · Booted" : ""}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton
          label="Hide simulator"
          className="ml-auto"
          onClick={() => toggleSimulator(threadId)}
        >
          <X className="size-3.5" />
        </IconButton>
      </div>
      {setup.status === "loading" ? (
        <Message>
          <LoaderCircle className="size-4 animate-spin" />
          Starting the simulator hub…
        </Message>
      ) : setup.status === "missing" ? (
        <Message>
          <span>
            Run iOS simulators here, for you and the agent. This installs expo-device-hub and
            agent-device from npm into ~/.masscode/tools.
          </span>
          <ActionButton onClick={() => void load(true)}>Set up</ActionButton>
        </Message>
      ) : setup.status === "installing" ? (
        <Message>
          <LoaderCircle className="size-4 animate-spin" />
          Installing the simulator tools. This can take a minute…
        </Message>
      ) : setup.status === "failed" ? (
        <Message>
          <span className="selectable">{setup.message}</span>
          <ActionButton onClick={() => void load(false)}>Try again</ActionButton>
        </Message>
      ) : booting ? (
        <Message>
          <LoaderCircle className="size-4 animate-spin" />
          Starting {devices.find((candidate) => candidate.id === booting)?.name ?? "the simulator"}…
        </Message>
      ) : bootError ? (
        <Message>
          <span className="selectable">{bootError}</span>
          {deviceId ? (
            <ActionButton onClick={() => void boot(deviceId)}>Try again</ActionButton>
          ) : null}
        </Message>
      ) : deviceId ? (
        <DeviceScreen key={deviceId} hub={setup.hub} deviceId={deviceId} />
      ) : devices.length === 0 ? (
        <Message>
          This Mac has no iOS simulators. Add one in Xcode → Settings → Components, then try again.
          <ActionButton onClick={() => void load(false)}>Try again</ActionButton>
        </Message>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Choose a simulator to start</p>
          {devices.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => void boot(candidate.id)}
              className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{candidate.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {candidate.version}
                {candidate.booted ? " · Booted" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

/** The live screen: an MJPEG stream, with touches and keys sent back over the hub's socket. */
function DeviceScreen({ hub, deviceId }: { hub: DeviceHub; deviceId: string }) {
  const socket = useRef<WebSocket | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLImageElement>(null);
  const touching = useRef(false);
  const [live, setLive] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    function connect() {
      const ws = new WebSocket(
        `${hub.origin.replace(/^http/, "ws")}/vendor/serve-sim/helper/ws?device=${deviceId}`,
        // The hub takes its token as a subprotocol, since a browser can't set WebSocket headers.
        [`serve-sim.token.${hub.token}`],
      );
      ws.binaryType = "arraybuffer";
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1000);
      };
      socket.current = ws;
    }
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [hub, deviceId]);

  // A multipart image may never fire `load`, so watch for its first frame instead.
  useEffect(() => {
    setLive(false);
    const poll = setInterval(() => {
      if (!screen.current?.naturalWidth) return;
      setLive(true);
      clearInterval(poll);
    }, 250);
    return () => clearInterval(poll);
  }, [attempt]);

  function send({ tag, ...payload }: Input) {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const message = new Uint8Array(1 + json.length);
    message[0] = tag;
    message.set(json, 1);
    socket.current.send(message);
  }

  function touch(type: "begin" | "move" | "end", event: React.PointerEvent<HTMLImageElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    send({
      tag: TOUCH,
      type,
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    });
  }

  function key(type: "down" | "up", event: React.KeyboardEvent) {
    if (event.metaKey) {
      if (type === "down" && event.shiftKey && event.code === "KeyH") {
        event.preventDefault();
        send({ tag: BUTTON, button: "home" });
      }
      return;
    }
    const usage = hidUsage(event.code);
    if (usage === null) return;
    event.preventDefault();
    send({ tag: KEY, type, usage });
  }

  return (
    <div
      ref={surface}
      tabIndex={0}
      aria-label="Simulator screen. Click to focus, then type to send keys."
      onKeyDown={(event) => key("down", event)}
      onKeyUp={(event) => key("up", event)}
      className="flex min-h-0 flex-1 flex-col items-center gap-3 p-4 outline-none"
    >
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
        <img
          key={attempt}
          ref={screen}
          src={`${hub.origin}/vendor/serve-sim/helper/${deviceId}/stream.mjpeg?token=${hub.token}&attempt=${attempt}`}
          alt=""
          draggable={false}
          onError={() => setTimeout(() => setAttempt((current) => current + 1), 1000)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            surface.current?.focus();
            touching.current = true;
            touch("begin", event);
          }}
          onPointerMove={(event) => {
            if (touching.current) touch("move", event);
          }}
          onPointerUp={(event) => {
            touching.current = false;
            touch("end", event);
          }}
          onPointerCancel={(event) => {
            touching.current = false;
            touch("end", event);
          }}
          className="max-h-full max-w-full touch-none rounded-[2rem] select-none"
        />
        {live ? null : (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Connecting…
          </div>
        )}
      </div>
      <IconButton label="Home (⌘⇧H)" onClick={() => send({ tag: BUTTON, button: "home" })}>
        <House className="size-3.5" />
      </IconButton>
    </div>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-3 py-1 text-xs text-foreground transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}
