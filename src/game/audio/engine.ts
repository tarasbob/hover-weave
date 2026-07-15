"use client";

import * as Tone from "tone";
import { RESONANCE } from "../core/constants";
import type { SimWorld } from "../core/world";
import type { PrecisionGrade, RunEventKind } from "../core/types";
import { clamp01, damp } from "../core/mathUtils";

/**
 * Fully generative adaptive audio: layered synth stems on one transport,
 * mixed by flow tier + speed, plus a pool of one-shot SFX synths.
 * Everything is created lazily on the first user gesture.
 */
export class AudioEngine {
  ready = false;
  private muted = false;

  private musicBus!: Tone.Gain;
  private sfxBus!: Tone.Gain;
  private musicFilter!: Tone.Filter;
  private musicVol = 0.8;
  private sfxVol = 0.9;

  // Stems.
  private padSynth!: Tone.PolySynth;
  private bassSynth!: Tone.MonoSynth;
  private kick!: Tone.MembraneSynth;
  private hat!: Tone.NoiseSynth;
  private arpSynth!: Tone.Synth;
  private leadSynth!: Tone.DuoSynth;

  private gains: Record<string, Tone.Gain> = {};
  private targets: Record<string, number> = {
    pad: 0.9, bass: 0, kick: 0, hat: 0, arp: 0, lead: 0,
  };

  // SFX synths.
  private whoosh!: Tone.NoiseSynth;
  private whooshFilter!: Tone.Filter;
  private whooshPanner!: Tone.Panner;
  private pluck!: Tone.Synth;
  private chime!: Tone.PolySynth;
  private impact!: Tone.MembraneSynth;
  private crashNoise!: Tone.NoiseSynth;
  private riser!: Tone.NoiseSynth;
  private riserFilter!: Tone.Filter;
  private thunder!: Tone.NoiseSynth;
  private thunderFilter!: Tone.Filter;

  private seqs: (Tone.Sequence | Tone.Loop)[] = [];
  private chordIndex = 0;
  private started = false;
  private musicActive = false;
  private bpmClock = 0;
  private initPromise: Promise<void> | null = null;

  /** D minor progression: i, VI, III, VII. */
  private chords = [
    ["D3", "F3", "A3", "C4"],
    ["Bb2", "D3", "F3", "A3"],
    ["F3", "A3", "C4", "E4"],
    ["C3", "E3", "G3", "Bb3"],
  ];
  private pentatonic = ["D4", "F4", "G4", "A4", "C5", "D5", "F5", "G5", "A5", "C6"];

  init(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    await Tone.start();
    const ctx = Tone.getContext();
    ctx.lookAhead = 0.05;

    const limiter = new Tone.Limiter(-1.5).toDestination();
    this.musicFilter = new Tone.Filter(9000, "lowpass", -12).connect(limiter);
    this.musicBus = new Tone.Gain(this.musicVol).connect(this.musicFilter);
    this.sfxBus = new Tone.Gain(this.sfxVol).connect(limiter);

    // --- Stems ----------------------------------------------------------
    for (const name of Object.keys(this.targets)) {
      this.gains[name] = new Tone.Gain(name === "pad" ? 0.9 : 0).connect(this.musicBus);
    }

    this.padSynth = new Tone.PolySynth(Tone.AMSynth, {
      harmonicity: 1.5,
      envelope: { attack: 1.6, decay: 0.4, sustain: 0.8, release: 2.4 },
      modulationEnvelope: { attack: 2, decay: 0.5, sustain: 0.6, release: 2 },
      volume: -14,
    }).connect(this.gains.pad);

    this.bassSynth = new Tone.MonoSynth({
      oscillator: { type: "fatsawtooth", count: 2, spread: 18 },
      filter: { type: "lowpass", rolloff: -24, Q: 2 },
      envelope: { attack: 0.004, decay: 0.18, sustain: 0.35, release: 0.12 },
      filterEnvelope: { attack: 0.004, decay: 0.14, sustain: 0.3, release: 0.1, baseFrequency: 90, octaves: 2.6 },
      volume: -10,
    }).connect(this.gains.bass);

    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.04,
      octaves: 7,
      envelope: { attack: 0.001, decay: 0.32, sustain: 0 },
      volume: -6,
    }).connect(this.gains.kick);

    this.hat = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.045, sustain: 0 },
      volume: -20,
    });
    const hatFilter = new Tone.Filter(9500, "highpass").connect(this.gains.hat);
    this.hat.connect(hatFilter);

    this.arpSynth = new Tone.Synth({
      oscillator: { type: "triangle8" },
      envelope: { attack: 0.004, decay: 0.12, sustain: 0.08, release: 0.14 },
      volume: -13,
    });
    const arpEcho = new Tone.FeedbackDelay("8n.", 0.32).connect(this.gains.arp);
    arpEcho.wet.value = 0.35;
    this.arpSynth.connect(arpEcho);

    this.leadSynth = new Tone.DuoSynth({
      voice0: { oscillator: { type: "sawtooth" }, envelope: { attack: 0.06, decay: 0.2, sustain: 0.5, release: 0.4 } },
      voice1: { oscillator: { type: "square" }, envelope: { attack: 0.08, decay: 0.2, sustain: 0.4, release: 0.4 } },
      harmonicity: 1.01,
      vibratoAmount: 0.12,
      vibratoRate: 5,
      volume: -18,
    });
    const leadVerb = new Tone.Reverb({ decay: 3.2, wet: 0.35 }).connect(this.gains.lead);
    this.leadSynth.connect(leadVerb);

    // --- Sequencing ------------------------------------------------------
    // Every trigger is guarded: BPM automation can occasionally emit two
    // events at the same transport tick, and monophonic synths throw on
    // non-increasing start times. One dropped note beats a dead loop.
    const safe = (fn: (time: number) => void) => (time: number) => {
      try {
        fn(time);
      } catch {
        /* dropped note */
      }
    };

    const t = Tone.getTransport();
    t.bpm.value = 116;

    // Chord pad, one chord per 2 bars.
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        const chord = this.chords[this.chordIndex % this.chords.length];
        this.padSynth.triggerAttackRelease(chord, "1m", time);
        this.chordIndex++;
      }), "2m").start(0),
    );

    // Bass: pumping eighths on the chord root.
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        const root = this.chords[this.chordIndex % this.chords.length][0];
        const note = Tone.Frequency(root).transpose(-12).toNote();
        this.bassSynth.triggerAttackRelease(note, "16n", time);
      }), "8n").start(0),
    );

    // Kick: four on the floor.
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        this.kick.triggerAttackRelease("C1", "8n", time);
      }), "4n").start(0),
    );

    // Hats: offbeat.
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        this.hat.triggerAttackRelease("16n", time);
      }), "8n").start("8n"),
    );

    // Arp: 16ths cycling chord tones across octaves.
    let arpStep = 0;
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        const chord = this.chords[this.chordIndex % this.chords.length];
        const shape = [0, 1, 2, 3, 2, 1, 2, 0];
        const idx = shape[arpStep % shape.length];
        const note = Tone.Frequency(chord[idx]).transpose(12).toNote();
        this.arpSynth.triggerAttackRelease(note, "16n", time);
        arpStep++;
      }), "16n").start(0),
    );

    // Lead: sparse call over the top at high tiers.
    let leadStep = 0;
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        const chord = this.chords[this.chordIndex % this.chords.length];
        const seq = [3, 2, 3, 1];
        const note = Tone.Frequency(chord[seq[leadStep % 4]]).transpose(24).toNote();
        this.leadSynth.triggerAttackRelease(note, "4n", time);
        leadStep++;
      }), "2n").start("4n"),
    );

    // --- SFX -------------------------------------------------------------
    this.whooshPanner = new Tone.Panner(0).connect(this.sfxBus);
    this.whooshFilter = new Tone.Filter(1200, "bandpass", -12).connect(this.whooshPanner);
    this.whooshFilter.Q.value = 1.4;
    this.whoosh = new Tone.NoiseSynth({
      noise: { type: "pink" },
      envelope: { attack: 0.005, decay: 0.16, sustain: 0 },
      volume: -8,
    }).connect(this.whooshFilter);

    this.pluck = new Tone.Synth({
      oscillator: { type: "sine" },
      envelope: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.08 },
      volume: -8,
    });
    const pluckShimmer = new Tone.FeedbackDelay("16n", 0.25).connect(this.sfxBus);
    pluckShimmer.wet.value = 0.25;
    this.pluck.connect(pluckShimmer);

    this.chime = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 8,
      envelope: { attack: 0.002, decay: 0.5, sustain: 0, release: 0.4 },
      volume: -12,
    }).connect(this.sfxBus);

    this.impact = new Tone.MembraneSynth({
      pitchDecay: 0.09,
      octaves: 8,
      envelope: { attack: 0.001, decay: 0.6, sustain: 0 },
      volume: -2,
    }).connect(this.sfxBus);

    this.crashNoise = new Tone.NoiseSynth({
      noise: { type: "brown" },
      envelope: { attack: 0.002, decay: 0.9, sustain: 0 },
      volume: -4,
    }).connect(this.sfxBus);

    this.riserFilter = new Tone.Filter(400, "bandpass").connect(this.sfxBus);
    this.riser = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.25, decay: 0.4, sustain: 0 },
      volume: -14,
    }).connect(this.riserFilter);

    this.thunderFilter = new Tone.Filter(220, "lowpass").connect(this.sfxBus);
    this.thunder = new Tone.NoiseSynth({
      noise: { type: "brown" },
      envelope: { attack: 0.4, decay: 2.4, sustain: 0 },
      volume: -6,
    }).connect(this.thunderFilter);

    this.ready = true;
    if (this.musicActive) this.startMusic();
  }

  setVolumes(music: number, sfx: number): void {
    this.musicVol = music;
    this.sfxVol = sfx;
    if (!this.ready) return;
    const target = this.musicActive ? music : music * 0.35;
    this.musicBus.gain.rampTo(this.muted ? 0 : target, 0.1);
    this.sfxBus.gain.rampTo(this.muted ? 0 : sfx, 0.1);
  }

  startMusic(): void {
    this.musicActive = true;
    if (!this.ready) return;
    const t = Tone.getTransport();
    if (t.state !== "started") t.start("+0.05");
    this.started = true;
    this.musicFilter.frequency.cancelScheduledValues(Tone.now());
    this.musicFilter.frequency.rampTo(9000, 0.4);
    this.musicBus.gain.rampTo(this.musicVol, 0.5);
  }

  pauseMusic(): void {
    this.musicActive = false;
    if (!this.ready) return;
    this.musicFilter.frequency.rampTo(500, 0.3);
    this.musicBus.gain.rampTo(this.musicVol * 0.35, 0.3);
  }

  /** Per-frame adaptive mixing. */
  update(world: SimWorld, dt: number): void {
    if (!this.ready || !this.started || !this.musicActive) return;
    const tier = world.flowTier;
    const speed = world.speedNorm;

    this.targets.pad = 0.9;
    this.targets.kick = world.status === "running" ? (tier >= 0 ? 0.75 : 0) : 0;
    this.targets.bass = tier >= 1 || speed > 0.35 ? 0.9 : world.status === "running" ? 0.35 : 0;
    this.targets.hat = tier >= 2 ? 0.8 : 0;
    this.targets.arp = tier >= 2 ? clamp01(0.4 + tier * 0.15) : 0;
    this.targets.lead = tier >= 4 ? 0.85 : 0;

    for (const [name, gain] of Object.entries(this.gains)) {
      const cur = gain.gain.value;
      const target = this.targets[name];
      if (Math.abs(cur - target) > 0.01) {
        gain.gain.value = damp(cur, target, 2.2, dt);
      }
    }

    // Speed opens the master filter; boost cranks it.
    const cutoff = 1400 + (speed * 0.75 + world.boostCharge * 0.25) * 12000;
    this.musicFilter.frequency.value = damp(this.musicFilter.frequency.value as number, cutoff, 3, dt);

    // BPM follows speed in occasional quantized ramps (per-frame writes make
    // the transport emit duplicate ticks, which mono synths reject).
    this.bpmClock += dt;
    if (this.bpmClock > 2) {
      this.bpmClock = 0;
      const t = Tone.getTransport();
      // Rhythm resonance (lab 5.4) pins the tempo to the sim's beat grid —
      // the adaptive speed/flow drift would detune it from the movers.
      const targetBpm = world.labFx.resonance
        ? RESONANCE.BPM
        : 116 + speed * 12 + Math.min(world.flowTier, 8);
      if (Math.abs(t.bpm.value - targetBpm) > 1.5) {
        t.bpm.rampTo(targetBpm, 1.2);
      }
    }
  }

  // --- One-shots ---------------------------------------------------------
  // Guarded: rapid duplicate triggers on mono synths throw on non-increasing
  // start times; a silently dropped one-shot is the right failure mode.

  private oneShot(fn: () => void): void {
    if (!this.ready) return;
    try {
      fn();
    } catch {
      /* dropped one-shot */
    }
  }

  nearMiss(side: number, grade: PrecisionGrade, precision: number): void {
    this.oneShot(() => {
      this.whooshPanner.pan.rampTo(Math.max(-1, Math.min(1, side)) * 0.82, 0.025);
      const gradeLift = grade === "perfect" ? 1400 : grade === "razor" ? 700 : 0;
      this.whooshFilter.frequency.value = 850 + gradeLift + precision * 900;
      this.whoosh.triggerAttackRelease("8n", undefined, 0.62 + precision * 0.38);
    });
  }

  /** Both-sides needle: centered whoosh + a rising two-note sting. */
  thread(tightness: number): void {
    this.oneShot(() => {
      this.whooshPanner.pan.rampTo(0, 0.02);
      this.whooshFilter.frequency.value = 2400 + tightness * 1600;
      this.whoosh.triggerAttackRelease("8n", undefined, 0.8);
      const now = Tone.now();
      this.chime.triggerAttackRelease("A5", "16n", now, 0.5 + tightness * 0.4);
      this.chime.triggerAttackRelease("D6", "16n", now + 0.07, 0.6 + tightness * 0.4);
    });
  }

  shard(combo: number): void {
    this.oneShot(() => {
      const idx = Math.min(combo - 1, this.pentatonic.length - 1);
      this.pluck.triggerAttackRelease(this.pentatonic[Math.max(0, idx)], "16n");
    });
  }

  shieldPickup(): void {
    this.oneShot(() => this.chime.triggerAttackRelease(["D5", "A5", "D6"], "8n"));
  }

  shieldBreak(): void {
    this.oneShot(() => {
      this.chime.triggerAttackRelease(["D4", "Ab4", "D5"], "16n");
      this.crashNoise.triggerAttackRelease("8n", undefined, 0.5);
    });
  }

  boostStart(): void {
    this.oneShot(() => {
      this.riserFilter.frequency.cancelScheduledValues(Tone.now());
      this.riserFilter.frequency.value = 300;
      this.riserFilter.frequency.rampTo(4200, 0.5);
      this.riser.triggerAttackRelease("2n");
    });
  }

  /** Surge window opened (lab 5.1): a bright two-note unlock shimmer. */
  surge(): void {
    this.oneShot(() => {
      const now = Tone.now();
      this.chime.triggerAttackRelease("E6", "32n", now, 0.5);
      this.chime.triggerAttackRelease("B6", "32n", now + 0.05, 0.38);
    });
  }

  /** Phase dash (lab 5.3): a hard lateral zip, panned with the burst. */
  dash(dir: number): void {
    this.oneShot(() => {
      this.whooshPanner.pan.rampTo(Math.max(-1, Math.min(1, dir)) * 0.9, 0.015);
      this.whooshFilter.frequency.value = 520;
      this.whoosh.triggerAttackRelease("16n", undefined, 0.9);
    });
  }

  /** Resonant perfect (lab 5.4): a high bell exactly on the beat. */
  resonant(): void {
    this.oneShot(() => this.chime.triggerAttackRelease("D7", "32n", undefined, 0.5));
  }

  flowTierUp(tier: number): void {
    this.oneShot(() => {
      const base = ["D5", "F5", "A5", "C6", "D6", "F6"];
      this.chime.triggerAttackRelease(base[Math.min(tier, base.length - 1)], "16n");
    });
  }

  biome(index: number): void {
    this.oneShot(() => {
      const notes = ["D5", "F5", "A5", "C6"];
      this.chime.triggerAttackRelease(
        [notes[index % notes.length], notes[(index + 2) % notes.length]],
        "16n",
        undefined,
        0.42,
      );
    });
  }

  death(): void {
    this.oneShot(() => {
      this.impact.triggerAttackRelease("A0", "2n");
      this.crashNoise.triggerAttackRelease("2n");
      this.musicFilter.frequency.cancelScheduledValues(Tone.now());
      this.musicFilter.frequency.rampTo(240, 0.8);
      this.musicBus.gain.rampTo(this.musicVol * 0.5, 0.8);
    });
  }

  /** Sprint horizon crossed alive: a rising resolution, not a crash. */
  finish(): void {
    this.oneShot(() => {
      const now = Tone.now();
      this.chime.triggerAttackRelease("D5", "8n", now, 0.7);
      this.chime.triggerAttackRelease("A5", "8n", now + 0.09, 0.8);
      this.chime.triggerAttackRelease("D6", "4n", now + 0.18, 0.9);
      this.musicFilter.frequency.cancelScheduledValues(now);
      this.musicFilter.frequency.rampTo(900, 1.2);
      this.musicBus.gain.rampTo(this.musicVol * 0.7, 1.2);
    });
  }

  thunderClap(intensity: number): void {
    this.oneShot(() => {
      this.thunderFilter.frequency.value = 150 + intensity * 220;
      this.thunder.triggerAttackRelease("1n", Tone.now() + 0.25 + Math.random() * 0.6, intensity * 0.8);
    });
  }

  uiClick(): void {
    this.oneShot(() => this.pluck.triggerAttackRelease("A5", "32n", undefined, 0.4));
  }

  /** Boost-smashed glass: a bright crystalline burst over a noise crunch. */
  shatter(): void {
    this.oneShot(() => {
      const now = Tone.now();
      this.crashNoise.triggerAttackRelease("16n", now, 0.45);
      this.chime.triggerAttackRelease(["E6", "B6"], "32n", now, 0.55);
      this.chime.triggerAttackRelease("E7", "32n", now + 0.04, 0.4);
    });
  }

  /** Bumper fling: a rubbery low boing panned with the launch direction. */
  bounce(dir: number): void {
    this.oneShot(() => {
      this.whooshPanner.pan.rampTo(Math.max(-1, Math.min(1, dir)) * 0.7, 0.02);
      this.impact.triggerAttackRelease("E2", "16n", undefined, 0.5);
      this.whooshFilter.frequency.value = 700;
      this.whoosh.triggerAttackRelease("16n", undefined, 0.5);
    });
  }

  /** A pulse beam ahead just fired: a short panned electric zap. */
  zap(side: number): void {
    this.oneShot(() => {
      this.whooshPanner.pan.rampTo(Math.max(-1, Math.min(1, side)) * 0.6, 0.015);
      this.whooshFilter.frequency.value = 3400;
      this.whoosh.triggerAttackRelease("32n", undefined, 0.32);
    });
  }

  /** Drama director stinger: meteors rumble, rushes ring. */
  eventAlert(kind: RunEventKind): void {
    this.oneShot(() => {
      const now = Tone.now();
      if (kind === "meteor") {
        this.thunderFilter.frequency.value = 220;
        this.thunder.triggerAttackRelease("1n", now, 0.7);
        this.chime.triggerAttackRelease(["D4", "Ab4"], "8n", now, 0.55);
      } else {
        this.chime.triggerAttackRelease("A5", "16n", now, 0.6);
        this.chime.triggerAttackRelease("D6", "16n", now + 0.08, 0.7);
        this.chime.triggerAttackRelease("F6", "8n", now + 0.16, 0.8);
      }
    });
  }
}
