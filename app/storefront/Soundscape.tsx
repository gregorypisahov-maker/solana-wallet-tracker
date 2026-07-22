"use client";

import { useEffect, useRef, useState } from "react";

const TRACK_PATH = "/audio/background-music.mp3";
const BACKGROUND_VOLUME = 0.14;

export default function Soundscape() {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const getAudio = () => {
    if (audioRef.current) return audioRef.current;

    const audio = new Audio(TRACK_PATH);
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = BACKGROUND_VOLUME;
    audio.setAttribute("playsinline", "true");
    audio.addEventListener("error", () => {
      setPlaying(false);
      setFailed(true);
    });
    audioRef.current = audio;
    return audio;
  };

  const stop = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setPlaying(false);
  };

  const start = async () => {
    try {
      const audio = getAudio();
      audio.volume = BACKGROUND_VOLUME;
      await audio.play();
      setFailed(false);
      setPlaying(true);
    } catch (error) {
      console.warn("[storefront] Background music could not start:", error);
      setPlaying(false);
      setFailed(true);
    }
  };

  const toggle = () => {
    if (playing) stop();
    else void start();
  };

  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.src = "";
        audio.load();
      }
      audioRef.current = null;
    };
  }, []);

  return (
    <>
      <button
        type="button"
        className={`sfSoundToggle ${playing ? "isPlaying" : ""} ${failed ? "hasError" : ""}`}
        onClick={toggle}
        aria-pressed={playing}
        aria-label={playing ? "Turn background music off" : "Turn background music on"}
        title="Background music from the uploaded track"
      >
        <span className="sfSoundBars" aria-hidden="true"><i /><i /><i /></span>
        <span>{failed ? "Tap to retry" : playing ? "Music on" : "Music off"}</span>
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
        .sfSoundToggle.hasError { color: #ffd3a8; border-color: rgba(255, 176, 92, 0.42); }
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
