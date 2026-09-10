/**
 * High-performance, cross-platform Web Audio manager for Singularity '26.
 * Bypasses modern browser autoplay restrictions on iOS Safari, Android Chrome,
 * desktop Chrome, Safari, and Edge via global interaction listeners, hardware
 * pipeline priming (silent buffer play), and synchronous/asynchronous context resumption.
 */

export interface GlitchOptions {
  /** Total number of random glitch events to schedule */
  events?: number;
  /** Total duration of the whole effect, in seconds */
  totalDuration?: number;
  /** Base frequency for tonal glitch blips, in Hz */
  baseFrequency?: number;
  /** How wildly frequency jumps between events (0 - 1). Jumps are stepped, not glided. */
  pitchChaos?: number;
  /** Overall output volume (0 - 1) */
  volume?: number;
  /** Probability (0-1) that a given event is a noise/static burst */
  noiseChance?: number;
  /** Probability (0-1) that a given event is silence (adds stutter gaps) */
  silenceChance?: number;
  /** Probability (0-1) that a given event is a buffer-skip stutter loop */
  stutterChance?: number;
  /** Probability (0-1) that a given event is a single hard click/pop */
  clickChance?: number;
  /** Probability (0-1) that a given event is a servo/motor PWM burst */
  servoChance?: number;
  /** Probability (0-1) that a given event is a metallic clank impact */
  clankChance?: number;
  /** Probability (0-1) that a tonal event gets ring-modulated */
  ringModChance?: number;
  /** Quantization steps for bit-depth reduction (lower = harsher/crunchier) */
  bitDepth?: number;
  /** Effective sample-hold factor for noise aliasing (higher = crunchier/more aliased) */
  sampleHold?: number;
  /** How strongly event timing snaps to a rhythmic tick grid (0 = fully random, 1 = fully quantized) */
  mechanicalness?: number;
  /** Size of the rhythmic tick grid, in seconds */
  gridSize?: number;
}

export const DEFAULT_GLITCH_OPTIONS: Required<GlitchOptions> = {
  events: 70,
  totalDuration: 1.55,
  baseFrequency: 800, // Harmonized with countdown beep fundamental (800 Hz)
  pitchChaos: 0.55,   // Keeps frequency variations anchored in the beep tonal register
  volume: 0.5,
  noiseChance: 0.15,
  silenceChance: 0.12,
  stutterChance: 0.15,
  clickChance: 0.1,
  servoChance: 0.18,
  clankChance: 0.15,
  ringModChance: 0.4,
  bitDepth: 5,
  sampleHold: 6,
  mechanicalness: 0.55,
  gridSize: 0.045,
};

const rand = (min: number, max: number) => Math.random() * (max - min) + min;
const choice = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/**
 * Generates a noise buffer with real sample-and-hold aliasing: instead of
 * one random value per sample, a random value is held for `holdFactor`
 * samples before jumping to the next. This produces harsh, stair-stepped
 * digital static of a genuinely low sample-rate signal, not smooth hiss.
 */
function createAliasedNoiseBuffer(
  ctx: AudioContext,
  duration: number,
  holdFactor: number
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const hold = Math.max(1, Math.floor(holdFactor));
  let current = Math.random() * 2 - 1;
  for (let i = 0; i < length; i++) {
    if (i % hold === 0) current = Math.random() * 2 - 1;
    data[i] = current;
  }
  return buffer;
}

/**
 * Renders a short tonal burst (with ring modulation baked in) into a buffer
 * so it can be looped sample-accurately for the buffer-skip stutter effect.
 */
function createStutterSourceBuffer(
  ctx: AudioContext,
  duration: number,
  frequency: number,
  useNoise: boolean,
  holdFactor: number
): AudioBuffer {
  if (useNoise) {
    return createAliasedNoiseBuffer(ctx, duration, holdFactor);
  }
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const ringFreq = frequency * rand(1.2, 2.5);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // Harmonic blend of square and sine/triangle for recognizable beep character with a digital edge
    const sine = Math.sin(2 * Math.PI * frequency * t);
    const carrier = 0.6 * Math.sign(sine) + 0.4 * sine;
    const ring = Math.sin(2 * Math.PI * ringFreq * t);
    data[i] = carrier * ring;
  }
  return buffer;
}

/** Quantizes a signal to a small number of steps — coarse bit-depth crush */
function createBitcrushCurve(steps: number): Float32Array {
  const curve = new Float32Array(512);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

/** Hard clipping curve for extra digital grit on the master bus */
function createHardClipCurve(amount: number): Float32Array {
  const curve = new Float32Array(512);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.max(-1, Math.min(1, x * amount));
  }
  return curve;
}

/**
 * Applies a near-instant hard gate to a GainNode: essentially on/off with
 * only enough ramp (1-2ms) to avoid a raw sample-jump click, no musical fade.
 */
function hardGate(gain: GainNode, start: number, end: number, peak: number) {
  const edge = Math.min(0.002, (end - start) / 4);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + edge);
  gain.gain.setValueAtTime(peak, Math.max(start + edge, end - edge));
  gain.gain.linearRampToValueAtTime(0, end);
}

/** Snaps a time value to the nearest tick of `gridSize`, blended by `amount` (0-1) */
function snapToGrid(time: number, gridSize: number, amount: number): number {
  if (gridSize <= 0 || amount <= 0) return time;
  const snapped = Math.round(time / gridSize) * gridSize;
  return time + (snapped - time) * amount;
}

export function scheduleGlitch(
  ctx: AudioContext,
  destination: AudioNode,
  startTime: number,
  opts: Required<GlitchOptions> = DEFAULT_GLITCH_OPTIONS
): number {
  const {
    events,
    totalDuration,
    baseFrequency,
    pitchChaos,
    noiseChance,
    silenceChance,
    stutterChance,
    clickChance,
    servoChance,
    clankChance,
    ringModChance,
    bitDepth,
    sampleHold,
    mechanicalness,
    gridSize,
  } = opts;

  const bitcrushCurve = createBitcrushCurve(bitDepth);
  const avgEventLength = totalDuration / events;
  let cursor = startTime;

  for (let i = 0; i < events; i++) {
    // Rhythmic quantization: event start snaps toward the tick grid, giving
    // the pattern a clockwork/machine pulse instead of fully random timing.
    cursor = snapToGrid(cursor, gridSize, mechanicalness * rand(0.4, 1));

    const eventLength = Math.max(0.006, avgEventLength * rand(0.35, 1.5));
    let roll = Math.random();

    // --- Silence gap: hard cutout, no signal ---
    if (roll < silenceChance) {
      cursor += eventLength;
      continue;
    }
    roll -= silenceChance;

    // --- Single hard click/pop ---
    if (roll < clickChance) {
      const clickLen = Math.min(eventLength, rand(0.002, 0.008));
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = rand(800, 4000);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(rand(0.6, 1), cursor);
      gain.gain.setValueAtTime(0, cursor + clickLen);
      osc.connect(gain).connect(destination);
      osc.start(cursor);
      osc.stop(cursor + clickLen + 0.001);
      cursor += eventLength;
      continue;
    }
    roll -= clickChance;

    // --- Servo/motor PWM burst: a rapid train of short pulses at a stepped
    //     frequency, like a servo hunting for position or a stepper driver
    //     buzzing. Tuned to 800Hz beep register. ---
    if (roll < servoChance) {
      const pulseCount = Math.floor(rand(5, 12));
      const pulseLen = Math.max(0.004, eventLength / pulseCount / 1.6);
      const gap = Math.max(0.001, eventLength / pulseCount - pulseLen);
      let servoFreq = Math.max(350, baseFrequency * rand(0.85, 1.25));
      let pCursor = cursor;

      for (let p = 0; p < pulseCount; p++) {
        // Frequency steps up/down each pulse, simulating position hunting
        servoFreq = Math.max(300, servoFreq * rand(0.9, 1.15));

        const osc = ctx.createOscillator();
        osc.type = choice(['triangle', 'square', 'sawtooth'] as OscillatorType[]);
        osc.frequency.setValueAtTime(servoFreq, pCursor);

        const shaper = ctx.createWaveShaper();
        shaper.curve = bitcrushCurve as any;
        shaper.oversample = 'none';

        const gain = ctx.createGain();
        hardGate(gain, pCursor, pCursor + pulseLen, rand(0.35, 0.7));

        osc.connect(shaper).connect(gain).connect(destination);
        osc.start(pCursor);
        osc.stop(pCursor + pulseLen + 0.005);

        pCursor += pulseLen + gap;
      }
      cursor += eventLength;
      continue;
    }
    roll -= servoChance;

    // --- Metallic clank impact: noise through two detuned high-Q resonant
    //     filters with a fast percussive decay — tuned around beep harmonic range. ---
    if (roll < clankChance) {
      const clankLen = Math.max(0.03, Math.min(eventLength * 2.5, rand(0.04, 0.14)));
      const impactFreq = rand(800, 2400);

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = createAliasedNoiseBuffer(ctx, clankLen, Math.max(1, sampleHold / 2));

      const filterA = ctx.createBiquadFilter();
      filterA.type = 'bandpass';
      filterA.frequency.value = impactFreq;
      filterA.Q.value = rand(8, 20);

      const filterB = ctx.createBiquadFilter();
      filterB.type = 'bandpass';
      filterB.frequency.value = impactFreq * rand(1.2, 1.8);
      filterB.Q.value = rand(8, 20);

      const shaper = ctx.createWaveShaper();
      shaper.curve = bitcrushCurve as any;
      shaper.oversample = 'none';

      const gain = ctx.createGain();
      const peak = rand(0.5, 1);
      gain.gain.setValueAtTime(0, cursor);
      gain.gain.linearRampToValueAtTime(peak, cursor + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, cursor + clankLen);

      noiseSource.connect(filterA);
      noiseSource.connect(filterB);
      filterA.connect(shaper);
      filterB.connect(shaper);
      shaper.connect(gain).connect(destination);

      noiseSource.start(cursor);
      noiseSource.stop(cursor + clankLen);
      cursor += eventLength;
      continue;
    }
    roll -= clankChance;

    // --- Buffer-skip stutter: render a tiny snippet, loop it hard ---
    if (roll < stutterChance) {
      const useNoise = Math.random() < 0.5;
      const jump = 1 + rand(-pitchChaos, pitchChaos);
      const freq = Math.max(200, baseFrequency * jump);
      const snippetLen = rand(0.008, 0.025);
      const repeats = Math.floor(rand(3, 9));

      const snippet = createStutterSourceBuffer(ctx, snippetLen, freq, useNoise, sampleHold);
      const source = ctx.createBufferSource();
      source.buffer = snippet;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = snippetLen;

      const shaper = ctx.createWaveShaper();
      shaper.curve = bitcrushCurve as any;
      shaper.oversample = 'none';

      const gain = ctx.createGain();
      const totalLen = snippetLen * repeats;
      hardGate(gain, cursor, cursor + totalLen, rand(0.4, 0.9));

      source.connect(shaper).connect(gain).connect(destination);
      source.start(cursor);
      source.stop(cursor + totalLen);
      cursor += eventLength;
      continue;
    }
    roll -= stutterChance;

    // --- Aliased noise/static burst ---
    if (roll < noiseChance) {
      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = createAliasedNoiseBuffer(ctx, eventLength, sampleHold);

      const bandpass = ctx.createBiquadFilter();
      bandpass.type = choice(['bandpass', 'highpass'] as BiquadFilterType[]);
      bandpass.frequency.value = rand(1200, 7000);
      bandpass.Q.value = rand(0.7, 8);

      const shaper = ctx.createWaveShaper();
      shaper.curve = bitcrushCurve as any;
      shaper.oversample = 'none';

      const gain = ctx.createGain();
      hardGate(gain, cursor, cursor + eventLength, rand(0.35, 0.85));

      noiseSource.connect(bandpass).connect(shaper).connect(gain).connect(destination);
      noiseSource.start(cursor);
      noiseSource.stop(cursor + eventLength);
      cursor += eventLength;
      continue;
    }

    // --- Tonal blip: triangle/sine/square harmonic to beep tone ---
    const osc = ctx.createOscillator();
    osc.type = choice(['triangle', 'sine', 'square'] as OscillatorType[]);

    const jump = 1 + rand(-pitchChaos, pitchChaos);
    const freq = Math.max(200, baseFrequency * jump);
    osc.frequency.setValueAtTime(freq, cursor);
    if (Math.random() < 0.5) {
      osc.frequency.setValueAtTime(
        Math.max(200, freq * rand(0.7, 1.4)),
        cursor + eventLength * 0.5
      );
    }

    const shaper = ctx.createWaveShaper();
    shaper.curve = bitcrushCurve as any;
    shaper.oversample = 'none';

    const gain = ctx.createGain();
    hardGate(gain, cursor, cursor + eventLength, rand(0.3, 0.8));

    if (Math.random() < ringModChance) {
      const ringOsc = ctx.createOscillator();
      ringOsc.type = 'sine';
      ringOsc.frequency.value = freq * rand(1.2, 2.5);
      const ringGain = ctx.createGain();
      ringGain.gain.value = 1;
      ringOsc.connect(ringGain.gain);
      osc.connect(ringGain).connect(shaper).connect(gain).connect(destination);
      ringOsc.start(cursor);
      ringOsc.stop(cursor + eventLength + 0.01);
    } else {
      osc.connect(shaper).connect(gain).connect(destination);
    }

    osc.start(cursor);
    osc.stop(cursor + eventLength + 0.01);

    cursor += eventLength;
  }

  return cursor - startTime;
}

type AudioStateListener = (unlocked: boolean) => void;

class SoundManager {
  private ctx: AudioContext | null = null;
  private isUnlocked: boolean = false;
  private listeners: Set<AudioStateListener> = new Set();
  private setupDone: boolean = false;

  constructor() {
    if (typeof window !== 'undefined') {
      this.initGlobalListeners();
    }
  }

  private getAudioContextClass(): typeof AudioContext | null {
    if (typeof window === 'undefined') return null;
    return (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext ||
      null
    );
  }

  public getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = this.getAudioContextClass();
      if (AudioCtx) {
        try {
          this.ctx = new AudioCtx();
        } catch (e) {
          console.warn('[Audio] Failed to instantiate AudioContext:', e);
        }
      }
    }
    return this.ctx;
  }

  public subscribe(listener: AudioStateListener): () => void {
    this.listeners.add(listener);
    listener(this.isUnlocked);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners() {
    this.listeners.forEach((fn) => {
      try {
        fn(this.isUnlocked);
      } catch (err) {
        console.error('[Audio] Error in listener:', err);
      }
    });
  }

  public checkUnlocked(): boolean {
    if (!this.ctx) {
      this.getContext();
    }
    if (this.ctx && this.ctx.state === 'running') {
      if (!this.isUnlocked) {
        this.isUnlocked = true;
        this.notifyListeners();
      }
      return true;
    }
    return this.isUnlocked;
  }

  /**
   * Unlock Web Audio hardware. Safe to call on ANY user gesture (touch, click, key).
   */
  public async unlock(): Promise<boolean> {
    const ctx = this.getContext();
    if (!ctx) return false;

    try {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      // Play 1-sample silent buffer — essential on iOS Safari to awaken audio hardware
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);

      if (ctx.state === 'running') {
        this.isUnlocked = true;
        this.notifyListeners();
        return true;
      }
    } catch (e) {
      console.warn('[Audio] Unlock attempt deferred until direct user gesture:', e);
    }

    const running = ctx.state === 'running';
    if (running !== this.isUnlocked) {
      this.isUnlocked = running;
      this.notifyListeners();
    }
    return running;
  }

  /**
   * Automatically arm user gesture listeners on window/document.
   */
  public initGlobalListeners() {
    if (this.setupDone || typeof window === 'undefined') return;
    this.setupDone = true;

    const handleInteraction = async () => {
      const ok = await this.unlock();
      if (ok) {
        // Remove listeners once unlocked
        removeListeners();
      }
    };

    const events = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'keydown', 'click'];
    const addListeners = () => {
      events.forEach((ev) => {
        window.addEventListener(ev, handleInteraction, { capture: true, passive: true });
      });
    };

    const removeListeners = () => {
      events.forEach((ev) => {
        window.removeEventListener(ev, handleInteraction, { capture: true });
      });
    };

    addListeners();

    // Also check on tab focus or visibility change
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.ctx && this.ctx.state === 'suspended') {
        this.unlock().catch(() => {});
      }
    });
  }

  /**
   * Synthesize and play the signature high-impact countdown beep.
   * Driven to 0 dBFS true peak with waveshaper saturation for maximum clarity and presence.
   */
  public async playBeep(freq = 800, durationMs = 150): Promise<boolean> {
    const ctx = this.getContext();
    if (!ctx) return false;

    try {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
    } catch {
      // Audio context might be restricted by browser until user touches page
      return false;
    }

    if (ctx.state !== 'running') {
      return false;
    }

    try {
      const now = ctx.currentTime;
      const durSec = durationMs / 1000;

      // Primary sine oscillator (clean fundamental)
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);

      // Harmonic triangle oscillator (presence & cutting through mobile speakers)
      const harm = ctx.createOscillator();
      harm.type = 'triangle';
      harm.frequency.setValueAtTime(freq, now);

      // Pre-gain: drives saturator to 100% capacity
      const preGain = ctx.createGain();
      preGain.gain.setValueAtTime(2.0, now);

      // Tanh Waveshaper: pushes every wave cycle right to the ±1.0 digital ceiling
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i * 2) / 1024 - 1;
        curve[i] = Math.tanh(x * 3.5);
      }
      shaper.curve = curve;

      // Master Envelope
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(1.0, now);
      masterGain.gain.setValueAtTime(1.0, now + durSec - 0.015);
      masterGain.gain.linearRampToValueAtTime(0, now + durSec);

      osc.connect(preGain);
      harm.connect(preGain);
      preGain.connect(shaper);
      shaper.connect(masterGain);
      masterGain.connect(ctx.destination);

      osc.start(now);
      harm.start(now);
      osc.stop(now + durSec + 0.01);
      harm.stop(now + durSec + 0.01);

      this.isUnlocked = true;
      this.notifyListeners();
      return true;
    } catch (err) {
      console.warn('[Audio] playBeep error:', err);
      return false;
    }
  }

  /**
   * Play a crisp, futuristic confirmation chime when the user clicks "ENTER EVENT".
   * Confirms to the user and the operating system that audio output is 100% active and primed.
   */
  public async playEnterChime(): Promise<boolean> {
    const ctx = this.getContext();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (ctx.state !== 'running') return false;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      // Futuristic ascending chime: 660Hz -> 1100Hz
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(1100, now + 0.12);

      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.26);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Optional no-op for backwards compatibility.
   */
  public async preloadGlitchSound(): Promise<void> {
    // Web Audio synthesizer generates sounds on the fly with 0ms latency.
    return Promise.resolve();
  }

  /**
   * Synthesize and play the harsh, technical digital glitch sound effect on glitch countdown steps (specifically 7, 4, 1).
   * Fully synthesized in-browser via Web Audio API (no audio files required).
   */
  public async playGlitchSound(customOpts?: GlitchOptions): Promise<boolean> {
    const ctx = this.getContext();
    if (!ctx) return false;

    try {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
    } catch {
      // Audio context might be restricted until user interaction
    }

    if (ctx.state !== 'running') {
      return false;
    }

    try {
      const opts: Required<GlitchOptions> = {
        ...DEFAULT_GLITCH_OPTIONS,
        ...customOpts,
      };

      // Master chain: hard clip -> highpass (thin, no boomy low end) -> compressor
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(opts.volume, ctx.currentTime);

      const clipper = ctx.createWaveShaper();
      clipper.curve = createHardClipCurve(2.2) as any;
      clipper.oversample = '2x';

      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 120;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 4;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.001;
      compressor.release.value = 0.05;

      masterGain.connect(clipper).connect(highpass).connect(compressor).connect(ctx.destination);

      const scheduledDuration = scheduleGlitch(ctx, masterGain, ctx.currentTime + 0.01, opts);

      setTimeout(() => {
        try {
          masterGain.disconnect();
          clipper.disconnect();
          highpass.disconnect();
          compressor.disconnect();
        } catch {}
      }, (scheduledDuration + 0.2) * 1000);

      this.isUnlocked = true;
      this.notifyListeners();
      return true;
    } catch (err) {
      console.warn('[Audio] playGlitchSound synthesis error:', err);
      return false;
    }
  }
}

export const soundManager = new SoundManager();
