"use client";

import * as Tone from "tone";
import { RESONANCE } from "../core/constants";
import type { SimWorld } from "../core/world";
import type { LandingGrade, PatternSkill, PrecisionGrade, RunEventKind } from "../core/types";
import { clamp01, damp } from "../core/mathUtils";

/**
 * Tiny silent WAV. Playing it through an HTMLAudioElement inside a user
 * gesture flips iOS into a "playback" media session, which (with
 * navigator.audioSession below) lets Web Audio ignore the ringer switch.
 */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

/**
 * Fully generative adaptive audio: layered synth stems on one transport,
 * mixed by flow tier + speed, plus a pool of one-shot SFX synths.
 * Everything is created lazily on the first qualifying user gesture.
 */
export class AudioEngine {
  ready = false;
  private muted = false;

  // Master chain: stems -> duck/musicBus -> widener -> filter -> comp -> limiter.
  private musicBus!: Tone.Gain;
  private duck!: Tone.Gain;
  private musicFilter!: Tone.Filter;
  private reverb!: Tone.Reverb;
  private delaySend!: Tone.PingPongDelay;
  private sfxBus!: Tone.Gain;
  private musicVol = 0.8;
  private sfxVol = 0.9;

  // Stems.
  private padSynth!: Tone.PolySynth;
  private bassSynth!: Tone.MonoSynth;
  private kick!: Tone.MembraneSynth;
  private snare!: Tone.NoiseSynth;
  private hat!: Tone.NoiseSynth;
  private openHat!: Tone.NoiseSynth;
  private sweep!: Tone.NoiseSynth;
  private arpSynth!: Tone.Synth;
  private leadSynth!: Tone.DuoSynth;

  private gains: Record<string, Tone.Gain> = {};
  private targets: Record<string, number> = {
    pad: 0.9, bass: 0, kick: 0, snare: 0, hat: 0, arp: 0, lead: 0,
  };

  // SFX synths.
  private whoosh!: Tone.NoiseSynth;
  private whooshFilter!: Tone.Filter;
  private whooshPanner!: Tone.Panner;
  private zip!: Tone.Synth;
  private pluck!: Tone.Synth;
  private chime!: Tone.PolySynth;
  private impact!: Tone.MembraneSynth;
  private subDrop!: Tone.Synth;
  private crashNoise!: Tone.NoiseSynth;
  private riser!: Tone.NoiseSynth;
  private riserFilter!: Tone.Filter;
  private boostNoise!: Tone.NoiseSynth;
  private boostLoopFilter!: Tone.Filter;
  private thunder!: Tone.NoiseSynth;
  private thunderFilter!: Tone.Filter;

  private seqs: (Tone.Sequence | Tone.Loop)[] = [];
  private started = false;
  private musicActive = false;
  private initPromise: Promise<void> | null = null;
  private mediaKicked = false;

  /**
   * Two alternating 8-bar sections in D minor. A broods (i VI III VII),
   * B lifts through the subdominant into a V7 pull (i iv VI V7).
   */
  private chordsA = [
    ["D3", "F3", "A3", "C4"],
    ["Bb2", "D3", "F3", "A3"],
    ["F3", "A3", "C4", "E4"],
    ["C3", "E3", "G3", "Bb3"],
  ];
  private chordsB = [
    ["D3", "F3", "A3", "C4"],
    ["G3", "Bb3", "D4", "F4"],
    ["Bb2", "D3", "F3", "A3"],
    ["A2", "C#3", "E3", "G3"],
  ];
  private pentatonic = ["D4", "F4", "G4", "A4", "C5", "D5", "F5", "G5", "A5", "C6"];

  private currentChord = this.chordsA[0];
  private chordIndex = 0;
  private section = 0;
  private tier = 0;

  /**
   * Install persistent unlock listeners on gestures that grant user
   * activation on every platform (iOS ignores pointerdown/touchstart, so
   * the sim's own input path can't be trusted for this). Listeners stay
   * until the context is verifiably running, and re-arm after the page
   * returns from the background, where iOS sometimes leaves the context
   * "running" but silent.
   */
  attachUnlock(doc: Document): () => void {
    let unlocked = false;
    const unlock = () => {
      if (unlocked) return;
      this.kickMediaSession();
      // Resume must be issued synchronously inside the gesture handler.
      void Tone.start().then(() => {
        if (Tone.getContext().state === "running") unlocked = true;
      });
      void this.init();
    };
    const onVisibility = () => {
      if (doc.visibilityState === "visible" && Tone.getContext().state !== "running") {
        unlocked = false;
      }
    };
    const events = ["touchend", "pointerup", "mousedown", "keydown"] as const;
    for (const name of events) doc.addEventListener(name, unlock, { capture: true, passive: true });
    doc.addEventListener("visibilitychange", onVisibility);
    return () => {
      for (const name of events) doc.removeEventListener(name, unlock, { capture: true });
      doc.removeEventListener("visibilitychange", onVisibility);
    };
  }

  private kickMediaSession(): void {
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      // Default "ambient" session dies with the iOS ringer switch.
      if (nav.audioSession) nav.audioSession.type = "playback";
    } catch {
      /* draft API, shape may shift */
    }
    if (this.mediaKicked) return;
    this.mediaKicked = true;
    try {
      const el = new Audio(SILENT_WAV);
      el.volume = 0.01;
      void el.play().then(() => {
        el.pause();
        el.src = "";
      }).catch(() => undefined);
    } catch {
      /* no HTMLAudioElement (tests) */
    }
  }

  init(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    await Tone.start();
    const ctx = Tone.getContext();
    ctx.lookAhead = 0.05;

    // --- Master chain -----------------------------------------------------
    const limiter = new Tone.Limiter(-1).toDestination();
    const comp = new Tone.Compressor({
      threshold: -18, ratio: 3, attack: 0.015, release: 0.18,
    }).connect(limiter);
    this.musicFilter = new Tone.Filter(9000, "lowpass", -12).connect(comp);
    const widener = new Tone.StereoWidener(0.3).connect(this.musicFilter);
    this.musicBus = new Tone.Gain(this.musicVol).connect(widener);
    // Pad/arp/lead and the shared FX returns ride the duck, so every kick
    // pumps the ambient bed out of its way — the classic synthwave breath.
    this.duck = new Tone.Gain(1).connect(this.musicBus);
    this.sfxBus = new Tone.Gain(this.sfxVol).connect(comp);

    // Shared space: one plate-ish reverb and one ping-pong echo as sends.
    this.reverb = new Tone.Reverb({ decay: 3.5, preDelay: 0.02 });
    this.reverb.wet.value = 1;
    this.reverb.connect(this.duck);
    this.delaySend = new Tone.PingPongDelay({ delayTime: "8n.", feedback: 0.3, wet: 1 });
    this.delaySend.connect(this.duck);
    const sfxRevSend = new Tone.Gain(0.12).connect(this.reverb);
    this.sfxBus.connect(sfxRevSend);

    // --- Stems ------------------------------------------------------------
    for (const name of Object.keys(this.targets)) {
      const bed = name === "pad" || name === "arp" || name === "lead";
      this.gains[name] = new Tone.Gain(name === "pad" ? 0.9 : 0).connect(
        bed ? this.duck : this.musicBus,
      );
    }

    this.padSynth = new Tone.PolySynth(Tone.AMSynth, {
      harmonicity: 1.5,
      envelope: { attack: 1.6, decay: 0.4, sustain: 0.8, release: 2.6 },
      modulationEnvelope: { attack: 2, decay: 0.5, sustain: 0.6, release: 2 },
      volume: -12,
    });
    const padChorus = new Tone.Chorus({ frequency: 0.6, delayTime: 3.5, depth: 0.5, wet: 0.5 })
      .connect(this.gains.pad)
      .start();
    this.padSynth.connect(padChorus);
    const padRevSend = new Tone.Gain(0.35).connect(this.reverb);
    this.gains.pad.connect(padRevSend);

    this.bassSynth = new Tone.MonoSynth({
      oscillator: { type: "fatsawtooth", count: 3, spread: 24 },
      filter: { type: "lowpass", rolloff: -24, Q: 2 },
      envelope: { attack: 0.004, decay: 0.18, sustain: 0.35, release: 0.12 },
      filterEnvelope: { attack: 0.004, decay: 0.14, sustain: 0.3, release: 0.1, baseFrequency: 90, octaves: 2.6 },
      volume: -9,
    }).connect(this.gains.bass);

    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.05,
      octaves: 10,
      envelope: { attack: 0.001, decay: 0.4, sustain: 0 },
      volume: -4,
    }).connect(this.gains.kick);

    this.snare = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.13, sustain: 0 },
      volume: -13,
    });
    const snareFilter = new Tone.Filter(1800, "bandpass", -12).connect(this.gains.snare);
    snareFilter.Q.value = 0.8;
    this.snare.connect(snareFilter);
    const snareRevSend = new Tone.Gain(0.25).connect(this.reverb);
    this.gains.snare.connect(snareRevSend);

    this.hat = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.045, sustain: 0 },
      volume: -19,
    });
    const hatFilter = new Tone.Filter(9500, "highpass").connect(this.gains.hat);
    this.hat.connect(hatFilter);
    this.openHat = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.35, sustain: 0 },
      volume: -22,
    }).connect(hatFilter);

    // Section-boundary swell, musical (rides the duck), not an SFX.
    const sweepFilter = new Tone.Filter(900, "bandpass").connect(this.duck);
    this.sweep = new Tone.NoiseSynth({
      noise: { type: "pink" },
      envelope: { attack: 1.7, decay: 0.5, sustain: 0 },
      volume: -18,
    }).connect(sweepFilter);

    this.arpSynth = new Tone.Synth({
      oscillator: { type: "triangle8" },
      envelope: { attack: 0.004, decay: 0.12, sustain: 0.08, release: 0.14 },
      volume: -12,
    }).connect(this.gains.arp);
    const arpDelaySend = new Tone.Gain(0.5).connect(this.delaySend);
    this.gains.arp.connect(arpDelaySend);

    this.leadSynth = new Tone.DuoSynth({
      voice0: { oscillator: { type: "sawtooth" }, envelope: { attack: 0.06, decay: 0.2, sustain: 0.5, release: 0.4 } },
      voice1: { oscillator: { type: "square" }, envelope: { attack: 0.08, decay: 0.2, sustain: 0.4, release: 0.4 } },
      harmonicity: 1.01,
      vibratoAmount: 0.16,
      vibratoRate: 5,
      portamento: 0.05,
      volume: -15,
    }).connect(this.gains.lead);
    const leadRevSend = new Tone.Gain(0.4).connect(this.reverb);
    this.gains.lead.connect(leadRevSend);

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

    // The transport is pinned to the sim's beat grid (fun-frontier 2.1):
    // movers, the resonant grading window, and the music share one tempo.
    const t = Tone.getTransport();
    t.bpm.value = RESONANCE.BPM;

    // Chords: one per 2 bars; sections of 4 chords alternate A/B, with a
    // noise swell through the last chord announcing the turn.
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        const prog = this.section === 0 ? this.chordsA : this.chordsB;
        const step = this.chordIndex % 4;
        this.currentChord = prog[step];
        this.padSynth.triggerAttackRelease(this.currentChord, "1m", time);
        if (step === 3) {
          this.sweep.triggerAttackRelease("1m", time + Tone.Time("1m").toSeconds());
        }
        if (step === 0 && this.chordIndex > 0) {
          this.openHat.triggerAttackRelease("8n", time, 0.9);
        }
        this.chordIndex++;
        if (this.chordIndex % 4 === 0) this.section = (this.section + 1) % 2;
      }), "2m").start(0),
    );

    // Bass: syncopated 16ths on the chord root with octave pops.
    const bassPattern = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0];
    let bassStep = 0;
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        const hit = bassPattern[bassStep % 16];
        bassStep++;
        if (!hit) return;
        const root = Tone.Frequency(this.currentChord[0]).transpose(hit === 2 ? 0 : -12);
        const accent = (bassStep - 1) % 16 === 0 || hit === 2;
        this.bassSynth.triggerAttackRelease(root.toNote(), "16n", time, accent ? 0.95 : 0.7);
      }), "16n").start(0),
    );

    // Kick: four on the floor; each hit ducks the ambient bed.
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        this.kick.triggerAttackRelease("C1", "8n", time);
        const g = this.duck.gain;
        g.cancelScheduledValues(time);
        g.setValueAtTime(0.5, time);
        g.linearRampToValueAtTime(1, time + 0.22);
      }), "4n").start(0),
    );

    // Snare on 2 and 4.
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        this.snare.triggerAttackRelease("16n", time, 0.9);
      }), "2n").start("4n"),
    );

    // Hats: offbeat 8ths, graduating to humanized 16ths at high flow.
    let hatStep = 0;
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        const step = hatStep % 4;
        hatStep++;
        if (this.tier >= 5) {
          const vel = step === 2 ? 0.85 : 0.4 + Math.random() * 0.15;
          this.hat.triggerAttackRelease("32n", time, vel);
        } else if (step === 2) {
          this.hat.triggerAttackRelease("16n", time, 0.7);
        }
      }), "16n").start(0),
    );

    // Open hat breathing on the "and" of beat 4.
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        this.openHat.triggerAttackRelease("8n", time, 0.5);
      }), "1m").start("0:3:2"),
    );

    // Arp: 16ths cycling chord tones, accents every beat, echo send.
    let arpStep = 0;
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        const shape = [0, 1, 2, 3, 2, 1, 2, 0];
        const idx = shape[arpStep % shape.length];
        const note = Tone.Frequency(this.currentChord[idx]).transpose(12).toNote();
        this.arpSynth.triggerAttackRelease(note, "16n", time, arpStep % 4 === 0 ? 0.9 : 0.55);
        arpStep++;
      }), "16n").start(0),
    );

    // Lead: three call-and-response motifs with rests to breathe.
    const phrases = [
      [3, 2, 3, 1],
      [0, 2, 1, 3],
      [2, 3, 2, 0],
    ];
    let leadStep = 0;
    this.seqs.push(
      new Tone.Loop(safe((time) => {
        const pos = leadStep % 8;
        leadStep++;
        if (pos >= 6) return; // rest, let the echo answer
        const phrase = phrases[Math.floor(leadStep / 16) % phrases.length];
        const note = Tone.Frequency(this.currentChord[phrase[pos % 4]]).transpose(24).toNote();
        this.leadSynth.triggerAttackRelease(note, "4n", time, pos === 0 ? 0.9 : 0.7);
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

    // Tonal zip layered on the whoosh: grade decides the pitch.
    this.zip = new Tone.Synth({
      oscillator: { type: "sine" },
      envelope: { attack: 0.002, decay: 0.09, sustain: 0, release: 0.05 },
      volume: -14,
    }).connect(this.whooshPanner);

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

    this.subDrop = new Tone.Synth({
      oscillator: { type: "sine" },
      envelope: { attack: 0.01, decay: 1.1, sustain: 0, release: 0.3 },
      volume: -4,
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

    // Sustained boost bed between boostStart and boostEnd.
    this.boostLoopFilter = new Tone.Filter(900, "bandpass").connect(this.sfxBus);
    this.boostLoopFilter.Q.value = 1.2;
    this.boostNoise = new Tone.NoiseSynth({
      noise: { type: "pink" },
      envelope: { attack: 0.35, decay: 0.1, sustain: 0.5, release: 0.5 },
      volume: -16,
    }).connect(this.boostLoopFilter);

    this.thunderFilter = new Tone.Filter(220, "lowpass").connect(this.sfxBus);
    this.thunder = new Tone.NoiseSynth({
      noise: { type: "brown" },
      envelope: { attack: 0.4, decay: 2.4, sustain: 0 },
      volume: -6,
    }).connect(this.thunderFilter);

    await this.reverb.ready;

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
    this.tier = tier;

    this.targets.pad = 0.9;
    this.targets.kick = world.status === "running" ? (tier >= 0 ? 0.75 : 0) : 0;
    this.targets.bass = tier >= 1 || speed > 0.35 ? 0.9 : world.status === "running" ? 0.35 : 0;
    this.targets.snare = tier >= 3 ? 0.75 : 0;
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

    // Flow brightens the bass, speed opens the master filter, boost cranks it.
    // Tempo never moves — the transport is pinned to the beat grid, and
    // intensity lives in the stem mix and the graze melody instead.
    this.bassSynth.filterEnvelope.baseFrequency = 80 + tier * 18 + speed * 120;
    const cutoff = 1400 + (speed * 0.75 + world.boostCharge * 0.25) * 12000;
    this.musicFilter.frequency.value = damp(this.musicFilter.frequency.value as number, cutoff, 3, dt);
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

  /**
   * Grazes play music (fun-frontier 5.1): the whoosh carries the physics
   * and a pitched voice carries the skill — the chain index walks up the
   * pentatonic (perfects ring an octave higher, brightness follows
   * precision), so a sustained graze chain is literally a melody climbing
   * over the generative bed.
   */
  nearMiss(side: number, grade: PrecisionGrade, precision: number, chain = 1): void {
    this.oneShot(() => {
      this.whooshPanner.pan.rampTo(Math.max(-1, Math.min(1, side)) * 0.82, 0.025);
      const gradeLift = grade === "perfect" ? 1400 : grade === "razor" ? 700 : 0;
      this.whooshFilter.frequency.value = 850 + gradeLift + precision * 900;
      this.whoosh.triggerAttackRelease("8n", undefined, 0.62 + precision * 0.38);
      const step = Math.min(this.pentatonic.length - 1, Math.max(0, chain - 1));
      const note = Tone.Frequency(this.pentatonic[step]).transpose(grade === "perfect" ? 12 : 0);
      this.zip.triggerAttackRelease(note.toFrequency(), "16n", undefined, 0.35 + precision * 0.45);
    });
  }

  /** Both-sides needle: centered whoosh + the current harmony rung as a chord. */
  thread(tightness: number): void {
    this.oneShot(() => {
      this.whooshPanner.pan.rampTo(0, 0.02);
      this.whooshFilter.frequency.value = 2400 + tightness * 1600;
      this.whoosh.triggerAttackRelease("8n", undefined, 0.8);
      const now = Tone.now();
      // Strum the pad's current chord two octaves up — a thread resolves
      // *inside* the music instead of on top of it.
      this.currentChord.forEach((n, i) => {
        this.chime.triggerAttackRelease(
          Tone.Frequency(n).transpose(24).toNote(),
          "16n",
          now + i * 0.045,
          0.42 + tightness * 0.4,
        );
      });
    });
  }

  /** Carve pump (lab "carve"): a low kinetic bite, panned with the rebound. */
  pump(dir: number, strength: number, wall = false): void {
    this.oneShot(() => {
      this.whooshPanner.pan.rampTo(Math.max(-1, Math.min(1, dir)) * 0.75, 0.02);
      this.whooshFilter.frequency.value = wall ? 480 : 900 + strength * 800;
      this.whoosh.triggerAttackRelease("16n", undefined, 0.4 + strength * 0.35);
      this.impact.triggerAttackRelease(wall ? "G1" : "C2", "32n", undefined, 0.22 + strength * 0.3);
    });
  }

  shard(combo: number): void {
    this.oneShot(() => {
      const idx = Math.min(combo - 1, this.pentatonic.length - 1);
      this.pluck.triggerAttackRelease(this.pentatonic[Math.max(0, idx)], "16n");
      if (combo >= 6) this.chime.triggerAttackRelease("D7", "32n", undefined, 0.3);
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
      // Ignite the sustained wind bed until boostEnd.
      this.boostLoopFilter.frequency.cancelScheduledValues(Tone.now());
      this.boostLoopFilter.frequency.value = 900;
      this.boostLoopFilter.frequency.rampTo(2400, 0.6);
      this.boostNoise.triggerAttack();
    });
  }

  boostEnd(): void {
    this.oneShot(() => {
      this.boostNoise.triggerRelease();
      this.boostLoopFilter.frequency.rampTo(700, 0.4);
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

  /** Resonant perfect (mainline, fun-frontier 2.1): a bell exactly on the beat. */
  resonant(): void {
    this.oneShot(() => this.chime.triggerAttackRelease("D7", "32n", undefined, 0.5));
  }

  /**
   * Skyhook launch (fun-frontier 6.1): a rising whoosh that opens with the
   * jump's energy — boosted lips get the full riser sweep.
   */
  launch(energy: number, boosted: boolean): void {
    this.oneShot(() => {
      this.whooshPanner.pan.rampTo(0, 0.02);
      this.whooshFilter.frequency.value = 700 + energy * 1500;
      this.whoosh.triggerAttackRelease("4n", undefined, 0.5 + energy * 0.4);
      if (boosted) {
        this.riserFilter.frequency.cancelScheduledValues(Tone.now());
        this.riserFilter.frequency.value = 500;
        this.riserFilter.frequency.rampTo(3600, 0.4);
        this.riser.triggerAttackRelease("4n", undefined, 0.5);
      }
    });
  }

  /**
   * Touchdown, graded: perfect strums the current chord like a thread (a
   * landing that resolves inside the music), clean is a soft settle, hard is
   * a low slam with crash noise scaled by the impact.
   */
  land(grade: LandingGrade, impact: number): void {
    this.oneShot(() => {
      if (grade === "perfect") {
        const now = Tone.now();
        this.currentChord.forEach((n, i) => {
          this.chime.triggerAttackRelease(
            Tone.Frequency(n).transpose(12).toNote(),
            "16n",
            now + i * 0.04,
            0.5,
          );
        });
        this.impact.triggerAttackRelease("C2", "32n", undefined, 0.2);
      } else if (grade === "hard") {
        this.impact.triggerAttackRelease("G1", "16n", undefined, 0.45 + impact * 0.4);
        this.crashNoise.triggerAttackRelease("16n", undefined, 0.2 + impact * 0.3);
      } else {
        this.impact.triggerAttackRelease("C2", "32n", undefined, 0.18 + impact * 0.15);
      }
    });
  }

  flowTierUp(tier: number): void {
    this.oneShot(() => {
      const base = ["D5", "F5", "A5", "C6", "D6", "F6"];
      this.chime.triggerAttackRelease(base[Math.min(tier, base.length - 1)], "16n");
    });
  }

  /** Predictive leitmotif: a skill-family phrase entering the lookahead. */
  foreshadow(skill: PatternSkill = "navigation"): void {
    this.oneShot(() => {
      const motifs: Record<PatternSkill, [string, string]> = {
        precision: ["D6", "A6"],
        rhythm: ["F5", "C6"],
        reaction: ["D4", "D5"],
        commitment: ["A4", "E5"],
        navigation: ["C5", "G5"],
      };
      const notes = motifs[skill];
      const now = Tone.now();
      this.chime.triggerAttackRelease(notes[0], "32n", now, 0.24);
      this.chime.triggerAttackRelease(notes[1], "16n", now + 0.12, 0.2);
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

  /** Mythic-depth arrival: a rare, widening three-note signature. */
  mythic(index: number): void {
    this.oneShot(() => {
      const chords = [
        ["D4", "A4", "F5"],
        ["C4", "G4", "Eb5"],
        ["A2", "E3", "D5"],
      ];
      const notes = chords[Math.min(index, chords.length - 1)];
      const now = Tone.now();
      notes.forEach((note, i) => {
        this.chime.triggerAttackRelease(note, i === 2 ? "2n" : "4n", now + i * 0.14, 0.7);
      });
    });
  }

  death(): void {
    this.oneShot(() => {
      const now = Tone.now();
      this.impact.triggerAttackRelease("A0", "2n");
      this.crashNoise.triggerAttackRelease("2n");
      // Cinematic sub-drop under the impact.
      this.subDrop.triggerAttackRelease(140, "1n", now, 0.9);
      this.subDrop.frequency.exponentialRampToValueAtTime(30, now + 0.7);
      this.musicFilter.frequency.cancelScheduledValues(now);
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
    this.oneShot(() => this.pluck.triggerAttackRelease("E5", "32n", undefined, 0.25));
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
