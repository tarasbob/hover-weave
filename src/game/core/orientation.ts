/** True on devices whose primary pointer is a finger (phones, tablets). */
export function isTouchDevice(): boolean {
  return typeof window !== "undefined" && matchMedia("(pointer: coarse)").matches;
}

/**
 * Best-effort hard landscape lock for touch devices. Android Chrome honors
 * `screen.orientation.lock` only in fullscreen, so we chain the two; iOS
 * Safari supports neither and silently falls through to the rotate-device
 * overlay (OrientationGate). Must be called from a user gesture.
 */
export function lockLandscape(): void {
  if (!isTouchDevice()) return;
  const lock = () => {
    try {
      // lock() is absent from iOS Safari (and some TS lib targets) —
      // feature-detect at runtime and swallow rejections.
      const orientation = screen.orientation as
        | (ScreenOrientation & { lock?: (type: string) => Promise<void> })
        | undefined;
      orientation?.lock?.("landscape").catch(() => undefined);
    } catch {
      // Unsupported — the OrientationGate overlay enforces instead.
    }
  };
  const root = document.documentElement;
  try {
    if (!document.fullscreenElement && root.requestFullscreen) {
      root.requestFullscreen({ navigationUI: "hide" }).then(lock, lock);
    } else {
      lock();
    }
  } catch {
    lock();
  }
}
