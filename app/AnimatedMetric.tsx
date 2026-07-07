"use client";

import { useEffect, useRef, useState } from "react";

export function AnimatedMetric({ label, value }: { label: string; value: number }) {
  const [displayValue, setDisplayValue] = useState(value);
  const [delta, setDelta] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const previousValue = useRef(value);

  useEffect(() => {
    const from = previousValue.current;
    const to = value;
    previousValue.current = value;

    if (from === to) {
      setDisplayValue(to);
      setDelta(0);
      setIsAnimating(false);
      return;
    }

    setDelta(to - from);
    setIsAnimating(true);

    const duration = 700;
    const start = performance.now();
    let frame = 0;
    let endTimer = 0;

    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(Math.round(from + (to - from) * eased));

      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        endTimer = window.setTimeout(() => {
          setIsAnimating(false);
          setDelta(0);
        }, 500);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(endTimer);
    };
  }, [value]);

  return (
    <div className={isAnimating ? "metric metricPulse" : "metric"}>
      <span>{label}</span>
      <div className="metricValue">
        <strong>{displayValue.toLocaleString("fr-FR")}</strong>
        {delta > 0 ? <em>+{delta.toLocaleString("fr-FR")}</em> : null}
      </div>
    </div>
  );
}
