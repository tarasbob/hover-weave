"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { useGameBundle } from "@/game/GameController";
import { heatScoreMult } from "@/game/core/heat";
import { SPRINT_MODE } from "@/game/core/constants";
import { ratingTier } from "@/game/core/rating";
import { parseFlight } from "@/game/core/replay";
import { dailyKey, weeklyKey } from "@/game/core/rng";
import { useGame } from "@/game/state/game";
import { CRAFTS, useMeta } from "@/game/state/meta";
import { TRIALS, medalFor } from "@/game/track/trials";

type FlightMode = "endless" | "daily" | "sprint";

const MODES: {
  id: FlightMode;
  number: string;
  name: string;
  label: string;
  description: string;
}[] = [
  {
    id: "endless",
    number: "01",
    name: "Free flight",
    label: "A NEW COURSE, EVERY RUN",
    description:
      "Read the gaps. Chase the close calls. Find a line that has never been flown.",
  },
  {
    id: "daily",
    number: "02",
    name: "Daily course",
    label: "ONE DAY. ONE SHARED COURSE.",
    description:
      "Learn today's line, race your ghost, and turn a good run into a great one.",
  },
  {
    id: "sprint",
    number: "03",
    name: "Sprint",
    label: `${SPRINT_MODE.DURATION} SECONDS. MAKE THEM COUNT.`,
    description:
      "A weekly course with a finish line. Balance speed and survival to bring it home.",
  },
];

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h15m-6-6 6 6-6 6"}
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/** Flight selection is separate from the heavier post-run and settings screens. */
export function TitleScreen({ inactive = false }: { inactive?: boolean }) {
  const bundle = useGameBundle();
  const setOverlay = useGame((s) => s.setOverlay);
  const meta = useMeta();
  const firstFlight = !meta.onboardingComplete;
  const [selected, setSelected] = useState<FlightMode>("endless");
  const [importError, setImportError] = useState("");
  const flightInput = useRef<HTMLInputElement>(null);
  const mode = MODES.find((item) => item.id === selected)!;
  const craft =
    CRAFTS.find((item) => item.id === meta.selectedCraft) ?? CRAFTS[0];
  const medals = TRIALS.filter((trial) =>
    medalFor(trial, meta.trialBest[trial.id]?.distance ?? 0),
  ).length;
  const heat = heatScoreMult(meta.selectedHeat);
  const best =
    selected === "daily"
      ? meta.dailyBest[dailyKey()]
      : selected === "sprint"
        ? meta.sprintBest[weeklyKey()]
        : null;

  const importFlight = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      // Reject before reading into memory; valid .flight payloads have a bounded RLE stream.
      if (file.size > 4 * 1024 * 1024)
        throw new Error(
          "That flight file is too large. Choose a file under 4 MB.",
        );
      const recording = parseFlight(await file.text());
      setImportError("");
      bundle.raceRecording(recording);
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Could not read that flight",
      );
    }
  };

  return (
    <motion.section
      className="flight-menu pointer-events-auto absolute inset-0 overflow-y-auto"
      inert={inactive}
      aria-hidden={inactive}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35 }}
      aria-label="Flight deck"
    >
      <div className="flight-menu-inner">
        <header className="flight-header">
          <div className="flight-brand">
            <svg
              viewBox="0 0 36 36"
              width="32"
              height="32"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m3 28 15-22 15 22-15-7-15 7Z"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M18 6v15m-8 3 8 7 8-7"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
            <span>
              HOVER WEAVE
              <span className="flight-brand-sub">THE FLIGHT DECK</span>
            </span>
          </div>
          <nav aria-label="Flight deck tools" className="flight-nav">
            {!firstFlight && (
              <button onClick={() => setOverlay("hangar")}>Hangar</button>
            )}
            <button onClick={() => setOverlay("help")}>How to fly</button>
            <button onClick={() => setOverlay("settings")}>Settings</button>
          </nav>
        </header>

        <div className="flight-hero">
          <div className="flight-intro">
            <div className="flight-eyebrow">
              <span className="flight-status-dot" />
              {firstFlight ? "YOUR FIRST FLIGHT STARTS HERE" : mode.label}
            </div>
            <h1>
              THREAD THE
              <br />
              <span>IMPOSSIBLE.</span>
            </h1>
            <p className="flight-description">
              {firstFlight
                ? "A ship. An endless horizon. The closer you fly to danger, the more alive it feels."
                : mode.description}
            </p>
            <button
              className="flight-launch"
              onClick={() =>
                bundle.startRun(firstFlight ? "endless" : selected)
              }
            >
              <span>
                {firstFlight
                  ? meta.totalRuns > 0
                    ? "Continue flight training"
                    : "Begin first flight"
                  : "Launch flight"}
              </span>
              <Arrow diagonal />
            </button>
            <div className="flight-launch-note">
              {firstFlight
                ? "Learn as you fly · Keyboard, touch or gamepad"
                : selected === "endless"
                  ? "Fresh course on every restart"
                  : best
                    ? `YOUR BEST  ${best.score.toLocaleString()} POINTS`
                    : selected === "daily"
                      ? dailyKey() + " · Your ghost remembers your best line"
                      : "A clear finish. A new personal best to chase."}
            </div>
            {!firstFlight && selected === "endless" && (
              <div className="flight-modifiers">
                <button onClick={() => setOverlay("heat")}>
                  Heat <span>{heat > 1 ? `×${heat.toFixed(2)}` : "OFF"}</span>
                </button>
                <button onClick={() => setOverlay("lab")}>
                  Experimental systems{" "}
                  <span>
                    {meta.selectedLab.length
                      ? `${meta.selectedLab.length} ON · UNRANKED`
                      : "OFF"}
                  </span>
                </button>
              </div>
            )}
          </div>

          <aside className="flight-profile" aria-label="Pilot progress">
            <div className="flight-eyebrow">
              {firstFlight ? "READY FOR DEPARTURE" : "YOUR FLIGHT RECORD"}
            </div>
            <div className="flight-profile-number">
              {firstFlight ? "01" : (meta.bestDistance / 1000).toFixed(2)}
              <span>
                {firstFlight ? " / FIRST CONTACT" : " KM / FARTHEST FLIGHT"}
              </span>
            </div>
            <div className="flight-profile-rule" />
            <div className="flight-profile-row">
              <span>CRAFT</span>
              <strong>{craft.name}</strong>
            </div>
            <div className="flight-profile-row">
              <span>PERSONAL BEST</span>
              <strong>
                {meta.bestScore.toLocaleString()} <small>PTS</small>
              </strong>
            </div>
            {!firstFlight && (
              <button
                className="flight-trial-link"
                onClick={() => setOverlay("trials")}
              >
                <span>
                  Trial mastery{" "}
                  <small>
                    {medals} / {TRIALS.length} courses medalled
                  </small>
                </span>
                <Arrow />
              </button>
            )}
            {meta.ratedRuns > 0 && (
              <div className="flight-rating">
                {ratingTier(meta.rating).name} · {meta.rating.toLocaleString()}
                <span>Local practice rating</span>
              </div>
            )}
            {firstFlight && (
              <p className="flight-profile-hint">
                Steer into the gaps.
                <br />
                Skim the edges to build Flow.
                <br />
                Spend your energy on speed.
              </p>
            )}
          </aside>
        </div>

        {firstFlight ? (
          <div className="flight-first-brief" aria-label="Flight basics">
            <span className="flight-eyebrow">FLIGHT BRIEF / 001</span>
            <p>
              <strong>Small movements. Big moments.</strong> Start with gentle
              steering. The flight introduces boost, rhythm, and jumping as you
              go.
            </p>
            <span className="flight-brief-key">
              ← → <span>STEER</span>
            </span>
          </div>
        ) : (
          <div
            className="flight-modes"
            role="group"
            aria-label="Choose a flight mode"
          >
            {MODES.map((item) => (
              <button
                key={item.id}
                aria-pressed={selected === item.id}
                className="flight-mode"
                onClick={() => setSelected(item.id)}
              >
                <span className="flight-mode-number">{item.number}</span>
                <span className="flight-mode-copy">
                  <strong>{item.name}</strong>
                  <small>
                    {item.id === "endless"
                      ? "Unpredictable. Unrestricted."
                      : item.id === "daily"
                        ? "Today's shared challenge."
                        : `${SPRINT_MODE.DURATION} seconds to the horizon.`}
                  </small>
                </span>
                <span className="flight-mode-indicator" />
              </button>
            ))}
          </div>
        )}

        <footer className="flight-footer">
          <span>SKILL IS THE ONLY UPGRADE.</span>
          {firstFlight && (
            <button onClick={() => meta.completeOnboarding()}>
              Explore all flight modes <Arrow />
            </button>
          )}
          {!firstFlight && (
            <div>
              <button onClick={() => setOverlay("trials")}>
                Skill trials <Arrow />
              </button>
              <button onClick={() => flightInput.current?.click()}>
                Race a flight <Arrow />
              </button>
            </div>
          )}
          <span className="flight-footer-controls">
            ← → STEER <i /> SHIFT BOOST <i /> ESC PAUSE
          </span>
        </footer>
        <input
          ref={flightInput}
          type="file"
          accept=".flight,application/json"
          className="hidden"
          tabIndex={-1}
          aria-label="Import a flight recording"
          onChange={importFlight}
        />
        {importError && (
          <p role="alert" className="flight-import-error">
            {importError}
          </p>
        )}
      </div>
    </motion.section>
  );
}
