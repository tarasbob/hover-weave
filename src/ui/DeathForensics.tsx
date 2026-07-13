"use client";

import { useMemo, useState } from "react";
import { FLOW, TRACK } from "@/game/core/constants";
import {
  TRACE_OPEN_CLEARANCE,
  type DeathForensics as Forensics,
  type ForensicsObstacle,
} from "@/game/core/world";

const W = 720;
const H = 200;
const PAD = 8;

/**
 * Kill-cam (roadmap 3.3): a scrubbable top-down map of the final approach —
 * your flown line vs. the validator's solved safe line, the obstacle
 * envelopes as they stood at impact, and a per-moment readout.
 * Travel runs left to right; up is your left.
 */
export function DeathForensicsPanel({ forensics }: { forensics: Forensics }) {
  const { s0, s1, trace, path, obstacles, deathS, deathX } = forensics;
  const [scrub, setScrub] = useState(Math.max(0, trace.length - 1));

  const sx = (s: number) => PAD + ((s - s0) / Math.max(1, s1 - s0)) * (W - 2 * PAD);
  const sy = (x: number) => H / 2 + (x / 32) * (H / 2 - PAD);

  const tracePoints = useMemo(
    () => trace.map((t) => `${sx(t.s).toFixed(1)},${sy(t.x).toFixed(1)}`).join(" "),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trace],
  );

  const sample = trace[Math.min(scrub, trace.length - 1)];
  const metersOut = sample ? Math.max(0, deathS - sample.s) : 0;

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/5 px-3 py-3 sm:px-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] tracking-[0.24em] text-white/40">KILL-CAM</div>
        <div className="flex gap-3 text-[9px] tracking-[0.14em] text-white/45">
          <span>
            <span className="mr-1 inline-block h-[2px] w-4 translate-y-[-2px] bg-white/85" />
            YOUR LINE
          </span>
          <span>
            <span className="mr-1 inline-block h-[2px] w-4 translate-y-[-2px] border-t-2 border-dashed border-cyan-300/80" />
            SAFE LINE
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-[2px] bg-rose-400/50" />
            FIELD
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 w-full rounded-lg bg-[#05030c]/80"
        role="img"
        aria-label="Top-down map of the final approach"
      >
        {/* Track edges */}
        {[-TRACK.X_LIMIT, TRACK.X_LIMIT].map((x) => (
          <line
            key={x}
            x1={PAD}
            x2={W - PAD}
            y1={sy(x)}
            y2={sy(x)}
            stroke="rgba(255,255,255,0.14)"
            strokeDasharray="2 5"
          />
        ))}

        {/* Obstacle envelopes at the moment of impact */}
        {obstacles.map((o, i) => (
          <ObstacleShape key={i} o={o} sx={sx} sy={sy} />
        ))}

        {/* Validator's solved safe line */}
        {path.map((seg, i) => (
          <polyline
            key={i}
            points={seg.map(([s, x]) => `${sx(s).toFixed(1)},${sy(x).toFixed(1)}`).join(" ")}
            fill="none"
            stroke="rgba(103,232,249,0.75)"
            strokeWidth="1.6"
            strokeDasharray="5 4"
          />
        ))}

        {/* Your line */}
        {trace.length >= 2 && (
          <polyline
            points={tracePoints}
            fill="none"
            stroke="rgba(255,255,255,0.88)"
            strokeWidth="1.8"
          />
        )}

        {/* Impact */}
        <g transform={`translate(${sx(deathS)}, ${sy(deathX)})`}>
          <circle r="7" fill="none" stroke="rgba(251,113,133,0.7)" strokeWidth="1.5" />
          <path d="M-4 -4 L4 4 M-4 4 L4 -4" stroke="#fb7185" strokeWidth="2" />
        </g>

        {/* Scrub marker */}
        {sample && (
          <g transform={`translate(${sx(sample.s)}, ${sy(sample.x)})`}>
            <line
              y1={-H}
              y2={H}
              stroke="rgba(252,211,77,0.28)"
              strokeWidth="1"
            />
            <circle r="4" fill="#fcd34d" stroke="#05030c" strokeWidth="1.4" />
          </g>
        )}
      </svg>

      <input
        type="range"
        min={0}
        max={Math.max(0, trace.length - 1)}
        step={1}
        value={scrub}
        aria-label="Scrub the final approach"
        onChange={(e) => setScrub(parseInt(e.target.value, 10))}
        className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-amber-300"
      />

      {sample && (
        <div className="mt-1.5 grid grid-cols-4 gap-2 text-center">
          <Readout label="TO IMPACT" value={`${metersOut.toFixed(0)} m`} />
          <Readout label="SPEED" value={`${Math.round(sample.speed * 3.6)} km/h`} />
          <Readout
            label="CLEARANCE"
            value={sample.clearance >= TRACE_OPEN_CLEARANCE ? "open" : `${sample.clearance.toFixed(2)} m`}
          />
          <Readout
            label="FLOW"
            value={`×${(1 + sample.flow * FLOW.MULT_PER_POINT).toFixed(2)}`}
          />
        </div>
      )}
    </div>
  );
}

function ObstacleShape({
  o,
  sx,
  sy,
}: {
  o: ForensicsObstacle;
  sx: (s: number) => number;
  sy: (x: number) => number;
}) {
  const fill = "rgba(244,63,94,0.30)";
  const stroke = "rgba(251,113,133,0.45)";
  // Map scale differs per axis: precompute spans from the transforms.
  const wS = Math.abs(sx(o.s + o.hs) - sx(o.s - o.hs));

  if (o.kind === "ring") {
    // A ring's blocked footprint is its two rims; the opening stays clear.
    const rims: [number, number][] = [
      [o.x - o.hx, o.x - o.inner],
      [o.x + o.inner, o.x + o.hx],
    ];
    return (
      <>
        {rims.map(([a, b], i) => (
          <rect
            key={i}
            x={sx(o.s) - Math.max(2, wS) / 2}
            y={Math.min(sy(a), sy(b))}
            width={Math.max(2, wS)}
            height={Math.abs(sy(b) - sy(a))}
            fill={fill}
            stroke={stroke}
            strokeWidth="0.8"
            rx="1"
          />
        ))}
      </>
    );
  }

  const hX = Math.abs(sy(o.x + o.hx) - sy(o.x - o.hx));
  const cx = sx(o.s);
  const cy = sy(o.x);
  // Local s-axis maps to screen direction (cos yaw, -sin yaw): rotate by -yaw.
  const deg = (-o.yaw * 180) / Math.PI;
  return (
    <rect
      x={cx - Math.max(2, wS) / 2}
      y={cy - Math.max(2, hX) / 2}
      width={Math.max(2, wS)}
      height={Math.max(2, hX)}
      fill={fill}
      stroke={stroke}
      strokeWidth="0.8"
      rx="1"
      transform={deg !== 0 ? `rotate(${deg.toFixed(1)} ${cx} ${cy})` : undefined}
    />
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/5 px-1.5 py-1.5">
      <div className="text-[8px] tracking-[0.2em] text-white/40">{label}</div>
      <div className="font-display text-xs font-bold tabular-nums text-white/85">{value}</div>
    </div>
  );
}
