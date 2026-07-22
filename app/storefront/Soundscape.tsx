"use client";

import { useEffect, useRef, useState } from "react";

type AudioContextConstructor = typeof AudioContext;
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: AudioContextConstructor };

export default function Soundscape() {
  const [playing, setPlaying] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = async () => {
    if (pulseTimerRef.current) {
      clearInterval(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
    const context = contextRef.current;
    contextRef.current = null;
    setPlaying(false);
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  };

  const start = async () => {
    if (contextRef.current) return;

    const AudioContextClass =
      window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    contextRef.current = context;
    await context.resume();

    const master = context.createGain();
    master.gain.value = 0.065;

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 18;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.02;
    compressor.release.value = 0.7;

    const atmosphere = context.createBiquadFilter();
    atmosphere.type = "lowpass";
    atmosphere.frequency.value = 430;
    atmosphere.Q.value = 0.8;

    atmosphere.connect(compressor);
    compressor.connect(master);
    master.connect(context.destination);

    const droneGain = context.createGain();
    droneGain.gain.value = 0.09;
    droneGain.connect(atmosphere);

    [46.25, 69.3, 92.5].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = index === 0 ? "sine" : "triangle";
      oscillator.frequency.value = frequency;
      oscillator.detune.value = index === 1 ? -7 : index === 2 ? 5 : 0;
      oscillator.connect(droneGain);
      oscillator.start();
    });

    const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseData.length; i += 1) {
      noiseData[i] = (Math.random() * 2 - 1) * 0.18;
    }
    const noise = context.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 850;
    noiseFilter.Q.value = 0.35;
    const noiseGain = context.createGain();
    noiseGain.gain.value = 0.018;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(compressor);
    noise.start();

    const lfo = context.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.09;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = 125;
    lfo.connect(lfoDepth);
    lfoDepth.connect(atmosphere.frequency);
    lfo.start();

    let step = 0;
    const schedulePulse = () => {
      if (context.state === "closed") return;
      const now = context.currentTime;
      const pulse = context.createOscillator();
      const pulseGain = context.createGain();
      const pulseFilter = context.createBiquadFilter();

      pulse.type = "sine";
      pulse.frequency.setValueAtTime(step % 4 === 3 ? 55 : 46.25, now);
      pulse.frequency.exponentialRampToValueAtTime(34, now + 0.65);

      pulseFilter.type = "lowpass";
      pulseFilter.frequency.value = 180;
      pulseGain.gain.setValueAtTime(0.0001, now);
      pulseGain.gain.exponentialRampToValueAtTime(0.34, now + 0.025);
      pulseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);

      pulse.connect(pulseFilter);
      pulseFilter.connect(pulseGain);
      pulseGain.connect(compressor);
      pulse.start(now);
      pulse.stop(now + 0.85);

      if (step % 4 === 2) {
        const accent = context.createOscillator();
        const accentGain = context.createGain();
        accent.type = "triangle";
        accent.frequency.value = 277.18;
        accentGain.gain.setValueAtTime(0.0001, now + 0.2);
        accentGain.gain.exponentialRampToValueAtTime(0.045, now + 0.27);
        accentGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
        accent.connect(accentGain);
        accentGain.connect(atmosphere);
        accent.start(now + 0.2);
        accent.stop(now + 1.3);
      }

      step += 1;
    };

    schedulePulse();
    pulseTimerRef.current = setInterval(schedulePulse, 1850);
    setPlaying(true);
  };

  const toggle = () => {
    if (playing) void stop();
    else void start();
  };

  useEffect(() => () => {
    if (pulseTimerRef.current) clearInterval(pulseTimerRef.current);
    void contextRef.current?.close().catch(() => undefined);
  }, []);

  return (
    <>
      <button
        type="button"
        className={`sfSoundToggle ${playing ? "isPlaying" : ""}`}
        onClick={toggle}
        aria-pressed={playing}
        aria-label={playing ? "Turn ambient sound off" : "Turn ambient sound on"}
        title="Original procedural soundscape"
      >
        <span className="sfSoundBars" aria-hidden="true"><i /><i /><i /></span>
        <span>{playing ? "Sound on" : "Sound off"}</span>
      </button>
      <style jsx>{`
        .sfSoundToggle {
          position: fixed;
          right: 18px;
          bottom: calc(18px + env(safe-area-inset-bottom));
          z-index: 80;
          display: inline-flex;
          align-items: center;
          gap: 9px;
          min-height: 44px;
          padding: 0 15px;
          border: 1px solid rgba(150, 170, 205, 0.24);
          border-radius: 999px;
          background: rgba(7, 12, 21, 0.84);
          color: rgba(225, 235, 250, 0.82);
          font: 600 12px/1 system-ui, sans-serif;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          box-shadow: 0 14px 42px rgba(0, 0, 0, 0.34), inset 0 1px rgba(255, 255, 255, 0.04);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          cursor: pointer;
          transition: border-color 180ms ease, color 180ms ease, transform 180ms ease;
        }
        .sfSoundToggle:hover { transform: translateY(-1px); border-color: rgba(88, 240, 166, 0.42); }
        .sfSoundToggle.isPlaying { color: #dfffee; border-color: rgba(88, 240, 166, 0.48); }
        .sfSoundBars { display: inline-flex; align-items: center; gap: 2px; height: 16px; }
        .sfSoundBars i { display: block; width: 2px; height: 5px; border-radius: 2px; background: currentColor; opacity: 0.8; }
        .isPlaying .sfSoundBars i { animation: sfSoundBar 780ms ease-in-out infinite alternate; }
        .isPlaying .sfSoundBars i:nth-child(2) { animation-delay: -260ms; }
        .isPlaying .sfSoundBars i:nth-child(3) { animation-delay: -520ms; }
        @keyframes sfSoundBar { from { height: 4px; } to { height: 15px; } }
        @media (max-width: 720px) {
          .sfSoundToggle { right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); padding: 0 13px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .isPlaying .sfSoundBars i { animation: none; height: 9px; }
        }
      `}</style>
    </>
  );
}
