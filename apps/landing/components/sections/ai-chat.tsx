"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, ArrowUp, RotateCw, MessageSquareDashed, Check, Loader2 } from "lucide-react";

const QUESTION = "how to host my app now?";
const STEPS = [
  "Reading your project",
  "Detected Next.js — provisioning database + storage",
  "Building & deploying to the cloud",
];
type Phase = "typing" | "sent" | "working" | "done";

// Anthropic sunburst mark.
const ClaudeBurst = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
    {Array.from({ length: 12 }).map((_, i) => {
      const a = (i * 30 * Math.PI) / 180;
      return (
        <line key={i}
          x1={12 + Math.cos(a) * 3} y1={12 + Math.sin(a) * 3}
          x2={12 + Math.cos(a) * 10.5} y2={12 + Math.sin(a) * 10.5}
          stroke="#fff" strokeWidth="2.1" strokeLinecap="round" />
      );
    })}
  </svg>
);

export function AiChat() {
  const [phase, setPhase] = useState<Phase>("typing");
  const [typed, setTyped] = useState("");
  const [steps, setSteps] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function clearAll() { timers.current.forEach(clearTimeout); timers.current = []; }
    function run() {
      clearAll();
      setPhase("typing"); setTyped(""); setSteps(0);
      let i = 0;
      const type = () => {
        i++; setTyped(QUESTION.slice(0, i));
        if (i < QUESTION.length) timers.current.push(setTimeout(type, 58));
        else {
          timers.current.push(setTimeout(() => setPhase("sent"), 550));
          timers.current.push(setTimeout(() => setPhase("working"), 1100));
          STEPS.forEach((_, idx) => timers.current.push(setTimeout(() => setSteps(idx + 1), 1750 + idx * 950)));
          const end = 1750 + STEPS.length * 950;
          timers.current.push(setTimeout(() => setPhase("done"), end + 300));
          timers.current.push(setTimeout(run, end + 5200));
        }
      };
      timers.current.push(setTimeout(type, 400));
    }
    run();
    return clearAll;
  }, []);

  // Auto-scroll to the newest line as the conversation grows.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [phase, steps]);

  const conversation = phase !== "typing";
  const showAi = phase === "working" || phase === "done";

  return (
    <div className="scard">
      <div className="scard-head">
        <div className="scard-headmain">
          <div className="scard-title"><span className="scard-logo"><ClaudeBurst /></span>Claude Code</div>
          <div className="scard-sub">~/projects/aurora-notes</div>
        </div>
        <span className="scard-refresh"><RotateCw size={14} /></span>
      </div>

      <div className="scard-body" ref={bodyRef}>
        {!conversation ? (
          <div className="scard-empty">
            <span className="scard-empty-ic"><MessageSquareDashed size={20} /></span>
            <div className="scard-empty-t">What are we shipping?</div>
            <div className="scard-empty-s">Ask Claude to host your app — press send to start.</div>
          </div>
        ) : (
          <div className="scard-msgs">
            <div className="s-user">{QUESTION}</div>
            {showAi && (
              <div className="s-ai">
                <p className="s-say">On it — I&apos;ll publish your app right now.</p>
                <div className="s-steps">
                  {STEPS.map((s, idx) => {
                    const state = steps > idx ? "done" : steps === idx ? "run" : "wait";
                    if (state === "wait") return null;
                    return (
                      <div className={"s-step " + state} key={s}>
                        {state === "done" ? <Check size={13} className="s-ck" /> : <Loader2 size={13} className="s-spin" />}
                        <span>{s}</span>
                      </div>
                    );
                  })}
                </div>
                {phase === "done" && (
                  <div className="s-live">
                    <div className="s-live-row"><span className="s-dot" />Live at <b>as76d.supersonic.cv</b></div>
                    <p className="s-say s-muted">Shared with your team and secured with SSL. Want me to invite anyone?</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="scard-input">
        <div className="scard-text">
          {phase === "typing" ? <>{typed}<span className="scard-caret" /></> : <span className="scard-ph">Ask Claude…</span>}
        </div>
        <div className="scard-row">
          <span className="s-plus"><Plus size={15} /></span>
          <span className="s-send"><ArrowUp size={15} strokeWidth={2.4} /></span>
        </div>
      </div>
    </div>
  );
}
