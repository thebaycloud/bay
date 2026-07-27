"use client";

import { cn } from "@/lib/utils";
import React, { useEffect, useRef, useState } from "react";

// CSS-only animation (no motion dependency) so text is always visible and the
// lines reveal reliably regardless of scroll position or reduced-motion quirks.

interface AnimatedSpanProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}

export const AnimatedSpan = ({ children, delay = 0, className }: AnimatedSpanProps) => (
  <div className={cn("term-line", className)} style={{ animationDelay: `${delay}ms` }}>
    {children}
  </div>
);

interface TypingAnimationProps {
  children: string;
  className?: string;
  duration?: number;
  delay?: number;
}

export const TypingAnimation = ({ children, className, duration = 55, delay = 0 }: TypingAnimationProps) => {
  const [text, setText] = useState("");
  const [started, setStarted] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  useEffect(() => {
    if (!started || done.current) return;
    let i = 0;
    const id = setInterval(() => {
      if (i < children.length) { setText(children.substring(0, i + 1)); i++; }
      else { done.current = true; clearInterval(id); }
    }, duration);
    return () => clearInterval(id);
  }, [children, duration, started]);

  return <div className={cn("term-type", className)}>{text}<span className="term-caret">▋</span></div>;
};

export const Terminal = ({ children, className, title = "supersonic" }: { children: React.ReactNode; className?: string; title?: string }) => (
  <div className={cn("terminal-frame", className)}>
    <div className="terminal-bar">
      <div className="terminal-dots"><span /><span /><span /></div>
      <span className="terminal-title">{title}</span>
    </div>
    <div className="terminal-body">{children}</div>
  </div>
);
