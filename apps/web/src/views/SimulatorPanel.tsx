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
import { cn } from "@masscode/ui/lib/utils";
import { ArrowLeft, ChevronDown, House, LoaderCircle, RotateCw, Unplug, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { IconButton } from "../components/icon-button.tsx";
import { connectDeviceStream, type DeviceStream } from "../lib/deviceStream.ts";
import { toggleSimulator, useSimulator } from "../lib/simulator.ts";
import { attachDevice, listDevices, useStore } from "../lib/store.ts";
import { Message } from "./BrowserPanel.tsx";

type Setup =
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | { readonly status: "installing" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly hub: DeviceHub; readonly devices: ReadonlyArray<Device> };

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

  /** Lists the devices again; false when that failed. */
  async function refresh(install: boolean) {
    const listed = await listDevices(install);
    if (!listed) setSetup({ status: "failed", message: "MassCode didn't answer. Try again." });
    else if (listed.error) setSetup({ status: "failed", message: listed.error });
    else if (!listed.hub) setSetup({ status: "missing" });
    else setSetup({ status: "ready", hub: listed.hub, devices: listed.devices });
    return Boolean(listed?.hub && !listed.error);
  }

  async function load(install: boolean) {
    setSetup({ status: install ? "installing" : "loading" });
    // The hub forgets its streams when it restarts, so reattach the thread's device.
    if ((await refresh(install)) && deviceId) await boot(deviceId);
  }

  async function boot(id: string) {
    setBooting(id);
    setBootError(null);
    const error = await attachDevice(threadId, id);
    // A booted emulator has a serial to stream by now.
    if (!error) await refresh(false);
    setBooting(null);
    setBootError(error);
  }

  // Loads once the daemon answers, and again after it restarts, which also restarts the hub.
  const connected = useStore((state) => state.connected);
  const loadOnConnect = useEffectEvent(() => void load(false));
  useEffect(() => {
    if (connected) loadOnConnect();
  }, [connected]);

  const devices = setup.status === "ready" ? setup.devices : [];
  const device = devices.find((candidate) => candidate.id === deviceId);

  // An agent may attach a device this list hasn't seen started.
  const refreshForDevice = useEffectEvent(() => {
    if (setup.status === "ready" && deviceId && !device?.streamId && !booting) void refresh(false);
  });
  useEffect(() => refreshForDevice(), [deviceId]);

  function panelBody() {
    if (setup.status === "loading") {
      return (
        <Message>
          <LoaderCircle className="size-4 animate-spin" />
          Starting the device hub…
        </Message>
      );
    }

    if (setup.status === "missing") {
      return (
        <Message>
          <span>
            Run iOS simulators and Android emulators here, for you and the agent. This installs
            expo-device-hub and agent-device from npm into ~/.masscode/tools.
          </span>
          <ActionButton onClick={() => void load(true)}>Set up</ActionButton>
        </Message>
      );
    }

    if (setup.status === "installing") {
      return (
        <Message>
          <LoaderCircle className="size-4 animate-spin" />
          Installing the device tools. This can take a minute…
        </Message>
      );
    }

    if (setup.status === "failed") {
      return (
        <Message>
          <span className="selectable">{setup.message}</span>
          <ActionButton onClick={() => void load(false)}>Try again</ActionButton>
        </Message>
      );
    }

    if (booting) {
      return (
        <Message>
          <LoaderCircle className="size-4 animate-spin" />
          Starting {devices.find((candidate) => candidate.id === booting)?.name ?? "the device"}…
        </Message>
      );
    }

    if (bootError) {
      return (
        <Message>
          <span className="selectable">{bootError}</span>
          {deviceId ? (
            <ActionButton onClick={() => void boot(deviceId)}>Try again</ActionButton>
          ) : null}
        </Message>
      );
    }

    if (device?.streamId) {
      return (
        <DeviceScreen
          key={`${device.id}:${device.streamId}`}
          hub={setup.hub}
          device={device}
          streamId={device.streamId}
        />
      );
    }

    if (deviceId) {
      return (
        <Message>
          <LoaderCircle className="size-4 animate-spin" />
          Starting the device…
        </Message>
      );
    }

    if (devices.length === 0) {
      return (
        <Message>
          This Mac has no iOS simulators or Android emulators. Add a simulator in Xcode → Settings →
          Components, or an emulator in Android Studio's Device Manager, then try again.
          <ActionButton onClick={() => void load(false)}>Try again</ActionButton>
        </Message>
      );
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Choose a device to start</p>
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
              {candidate.booted ? " · Running" : ""}
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <aside
      ref={aside}
      aria-label="Simulator"
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
            <span className="truncate">{device?.name ?? "Choose a device"}</span>
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
                    {candidate.booted ? " · Running" : ""}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton
          label="Detach device; it shuts down after 10 idle minutes if started here"
          className="ml-auto"
          disabled={!deviceId}
          onClick={() => void attachDevice(threadId, null)}
        >
          <Unplug className="size-3.5" />
        </IconButton>
        <IconButton label="Hide simulator" onClick={() => toggleSimulator(threadId)}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {panelBody()}
    </aside>
  );
}

/** The live screen, with touches, keys and hardware buttons sent back to the device. */
function DeviceScreen({
  hub,
  device,
  streamId,
}: {
  hub: DeviceHub;
  device: Device;
  streamId: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLImageElement>(null);
  const stream = useRef<DeviceStream | null>(null);
  const touching = useRef(false);
  const [streaming, setStreaming] = useState(false);
  const [mjpegUrl, setMjpegUrl] = useState<string | null>(null);

  useEffect(() => {
    const connected = connectDeviceStream(hub, device.platform, streamId, canvas.current!, {
      onStatus: (status) => setStreaming(status === "streaming"),
      onMjpeg: setMjpegUrl,
    });
    stream.current = connected;

    return () => connected.stop();
  }, [hub, device.platform, streamId]);

  // A multipart image may never fire `load`, so watch for its first frame instead.
  useEffect(() => {
    if (!mjpegUrl) return;

    const poll = setInterval(() => {
      if (!fallback.current?.naturalWidth) return;
      setStreaming(true);
      clearInterval(poll);
    }, 250);
    return () => clearInterval(poll);
  }, [mjpegUrl]);

  function touch(type: "begin" | "move" | "end", event: React.PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    stream.current?.touch(
      type,
      Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    );
  }

  const pointerHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      surface.current?.focus();
      touching.current = true;
      touch("begin", event);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (touching.current) touch("move", event);
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      touching.current = false;
      touch("end", event);
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
      touching.current = false;
      touch("end", event);
    },
  };

  function sendKey(phase: "down" | "up", event: React.KeyboardEvent) {
    if (event.metaKey) {
      // Apple's Simulator shortcuts: ⌘⇧H for Home, ⌘→ to rotate.
      if (phase !== "down") return;
      if (event.shiftKey && event.code === "KeyH") stream.current?.press("home");
      else if (event.code === "ArrowRight") stream.current?.rotate();
      else return;
      event.preventDefault();
      return;
    }

    // Tab still moves focus out, so the screen never traps the keyboard.
    if (event.key === "Tab") return;
    event.preventDefault();
    stream.current?.sendKey(event.nativeEvent, phase);
  }

  return (
    <div
      ref={surface}
      tabIndex={0}
      aria-label="Device screen. Click to focus, then type to send keys."
      onKeyDown={(event) => sendKey("down", event)}
      onKeyUp={(event) => sendKey("up", event)}
      className="flex min-h-0 flex-1 flex-col items-center gap-3 p-4 outline-none"
    >
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
        <canvas
          ref={canvas}
          {...pointerHandlers}
          className={cn(
            "max-h-full max-w-full touch-none rounded-[2rem] select-none",
            mjpegUrl && "hidden",
          )}
        />
        {mjpegUrl ? (
          <img
            ref={fallback}
            src={mjpegUrl}
            alt=""
            draggable={false}
            {...pointerHandlers}
            className="max-h-full max-w-full touch-none rounded-[2rem] select-none"
          />
        ) : null}
        {streaming ? null : (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Connecting…
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        {device.platform === "android" ? (
          <IconButton label="Back (Esc)" onClick={() => stream.current?.press("back")}>
            <ArrowLeft className="size-3.5" />
          </IconButton>
        ) : null}
        <IconButton
          label={device.platform === "ios" ? "Home (⌘⇧H)" : "Home"}
          onClick={() => stream.current?.press("home")}
        >
          <House className="size-3.5" />
        </IconButton>
        {device.platform === "ios" ? (
          <IconButton label="Rotate (⌘→)" onClick={() => stream.current?.rotate()}>
            <RotateCw className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
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
