/** True on devices whose primary pointer is a finger (phones, tablets). */
export function isTouchDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenRoot = Omit<HTMLElement, "requestFullscreen"> & {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export function isStandalone(): boolean {
  return typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches ||
    (window.matchMedia("(display-mode: fullscreen)").matches && !isFullscreen()) ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

export function isFullscreen(): boolean {
  return typeof document !== "undefined" && Boolean(document.fullscreenElement ||
    (document as FullscreenDocument).webkitFullscreenElement);
}

export function supportsFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement as FullscreenRoot;
  const doc = document as FullscreenDocument;
  return Boolean((root.requestFullscreen && document.fullscreenEnabled !== false) ||
    (root.webkitRequestFullscreen && doc.webkitFullscreenEnabled !== false));
}

async function requestLandscape(): Promise<void> {
  if (!isTouchDevice()) return;
  try {
    const orientation = window.screen?.orientation as
      (ScreenOrientation & { lock?: (type: string) => Promise<void> }) | undefined;
    await orientation?.lock?.("landscape");
  } catch {
    // Browsers may disallow locking. The portrait overlay pauses active runs.
  }
}

export type FullscreenResult = "entered" | "exited" | "standalone" | "unsupported" | "failed";

/** Must be called from a user gesture. Detect capabilities rather than iOS versions. */
export async function enterFullscreen(): Promise<FullscreenResult> {
  if (isStandalone()) { await requestLandscape(); return "standalone"; }
  if (!supportsFullscreen()) return "unsupported";
  try {
    if (!isFullscreen()) {
      const root = document.documentElement as FullscreenRoot;
      if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: "hide" });
      else await root.webkitRequestFullscreen?.();
    }
    await requestLandscape();
    return isFullscreen() ? "entered" : "failed";
  } catch {
    return "failed";
  }
}

export async function toggleFullscreen(): Promise<FullscreenResult> {
  if (!isFullscreen()) return enterFullscreen();
  try {
    const doc = document as FullscreenDocument;
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
    return "exited";
  } catch {
    return "failed";
  }
}

/** Best effort on launch; explicit setup controls provide failure/install guidance. */
export function lockLandscape(): void {
  if (isTouchDevice()) void enterFullscreen();
}
