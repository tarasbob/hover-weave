"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useGameBundle } from "@/game/GameController";
import { useSettings } from "@/game/state/settings";
import {
  isFullscreen, isStandalone, supportsFullscreen, toggleFullscreen,
} from "@/game/core/orientation";
import type { TiltStatus } from "@/game/core/tilt";

const subscribeTouch = (notify: () => void) => {
  const media = window.matchMedia("(pointer: coarse)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const readTouch = () => window.matchMedia("(pointer: coarse)").matches;
const noTouch = () => false;
const tiltOff = (): TiltStatus => "off";

export function useTouchControls(): boolean {
  return useSyncExternalStore(subscribeTouch, readTouch, noTouch);
}

const messages: Record<TiltStatus, string> = {
  off: "Hold either half of the track to steer. Two fingers boost.",
  requesting: "Allow motion access in your device’s prompt.",
  waiting: "Hold your phone slightly upright, then turn it like a steering wheel.",
  ready: "Turn gently to steer gently; turn farther for a harder turn. Touch still works.",
  denied: "Motion access wasn’t allowed. Touch steering is ready. You can try enabling tilt again.",
  unavailable: "No usable motion data. Hold the screen slightly upright, or use touch steering. Motion needs a secure connection and a supported device.",
};

export function FullscreenControl() {
  const [fullscreen, setFullscreen] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [supported, setSupported] = useState(false);
  const [help, setHelp] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const update = () => {
      setFullscreen(isFullscreen());
      setStandalone(isStandalone());
      setSupported(supportsFullscreen());
    };
    update();
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    const display = matchMedia("(display-mode: standalone)");
    display.addEventListener("change", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
      display.removeEventListener("change", update);
    };
  }, []);

  return (
    <div className="mobile-fullscreen-control">
      {standalone ? <span className="mobile-standalone-status">Playing from Home Screen</span> : (
        <button
          type="button"
          className="mobile-option"
          aria-expanded={!supported ? help : undefined}
          onClick={() => {
            if (!supported) { setHelp(!help); return; }
            void toggleFullscreen().then((result) => {
              setFailed(result === "failed");
              if (result === "unsupported") setHelp(true);
            });
          }}
        >
          <span aria-hidden="true">⛶</span> {fullscreen ? "Exit full screen" : "Full screen"}
        </button>
      )}
      {failed && <p role="status" className="mobile-control-hint">Full screen couldn’t start. Try again, or play from your Home Screen.</p>}
      {help && (
        <div className="mobile-install-guide" role="status">
          <strong>Full screen on iPhone</strong>
          <p>In Safari, open Share (sometimes inside the ••• menu), choose <b>Add to Home Screen</b>, then enable <b>Open as Web App</b> if shown. Tap Add and launch Hover Weave from its new icon.</p>
          <p>This browser doesn’t offer full screen for the game. A Home Screen web app hides the browser controls.</p>
        </div>
      )}
    </div>
  );
}

/** Shared setup on title, pause, settings and the portrait prompt. */
export function MobileSetup({ compact = false }: { compact?: boolean }) {
  const { input } = useGameBundle();
  const mobile = useTouchControls();
  const status = useSyncExternalStore(input.tilt.subscribe, input.tilt.getSnapshot, tiltOff);
  const preference = useSettings((s) => s.mobileControl);
  const fullAngle = useSettings((s) => s.tiltFullAngle);
  const setMobileControl = useSettings((s) => s.setMobileControl);
  const setTiltFullAngle = useSettings((s) => s.setTiltFullAngle);
  const [preview, setPreview] = useState(0);
  const [centered, setCentered] = useState(false);
  const active = status === "ready" || status === "waiting" || status === "requesting";

  useEffect(() => {
    if (status !== "ready" || compact) return;
    const timer = setInterval(() => setPreview(input.tilt.poll(performance.now())), 100);
    return () => clearInterval(timer);
  }, [compact, input, status]);

  if (!mobile) return null;

  return (
    <section className={`mobile-setup ${compact ? "mobile-setup-compact" : ""}`} aria-label="Mobile play" data-ui>
      {!compact && <div className="mobile-control-heading">MOBILE PLAY</div>}
      <div className="mobile-control-options">
        <button
          type="button"
          className="mobile-option"
          aria-pressed={active}
          disabled={status === "requesting"}
          onClick={() => {
            setCentered(false);
            if (active) {
              input.tilt.disable();
              setMobileControl("touch");
            } else {
              // Invoke permission before awaiting any other gesture-only API.
              void input.tilt.enable();
              setMobileControl("tilt");
            }
          }}
        >
          <span aria-hidden="true">◉</span> {active ? "Tilt steering on" : "Enable tilt steering"}
        </button>
        {status === "ready" && (
          <button type="button" className="mobile-option" onClick={() => {
            input.tilt.recalibrate();
            setPreview(0);
            setCentered(true);
          }}>Center steering</button>
        )}
        <FullscreenControl />
      </div>
      <p className="mobile-control-hint" role="status">
        {centered && status === "ready" ? "Centered. This hold position now steers straight. " : ""}
        {preference === "tilt" && status === "off" ? "Tap Enable tilt steering to allow motion for this visit. " : ""}
        {messages[status]}
      </p>
      {!compact && active && (
        <div className="mobile-tilt-adjustment">
          <div className="mobile-steering-meter" aria-hidden="true">
            <span style={{ transform: `translateX(${preview * 82}px)` }} />
          </div>
          <label>
            Full steering at {fullAngle}°
            <input type="range" min="15" max="45" step="1" value={fullAngle}
              aria-label="Tilt angle for full steering" onChange={(event) => {
                const value = Number(event.target.value);
                input.tilt.axis.fullAngle = value;
                setTiltFullAngle(value);
              }} />
          </label>
          <p className="mobile-control-hint">Smaller angles respond faster. Center steering while holding your phone comfortably.</p>
        </div>
      )}
    </section>
  );
}

export function MobileBoost() {
  const { input } = useGameBundle();
  const mobile = useTouchControls();
  useEffect(() => () => input.setBoostHeld(false), [input]);
  if (!mobile) return null;
  return (
    <button type="button" data-ui className="mobile-boost pointer-events-auto" aria-label="Hold to boost"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        input.setBoostHeld(true);
      }}
      onPointerUp={() => input.setBoostHeld(false)}
      onPointerCancel={() => input.setBoostHeld(false)}
      onLostPointerCapture={() => input.setBoostHeld(false)}
      onKeyDown={(event) => {
        if (event.code === "Space" || event.code === "Enter") { event.preventDefault(); input.setBoostHeld(true); }
      }}
      onKeyUp={() => input.setBoostHeld(false)}
      onBlur={() => input.setBoostHeld(false)}
    >BOOST <span aria-hidden="true">↑</span></button>
  );
}
