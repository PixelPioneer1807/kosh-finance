import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Circular progress (0..1, clamped for drawing). The arc uses the item's own identity colour;
 * the track is a light wash of that same colour so the state reads across the whole ring.
 * Exposed to assistive tech as a progressbar with a percentage.
 */
export function ProgressRing({
  value,
  color,
  size = 48,
  stroke = 4,
  label,
  className,
  children,
}: {
  value: number;
  color: string;
  size?: number;
  stroke?: number;
  /** Accessible name, e.g. "Laptop: 45% saved". */
  label: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} style={{ stroke: `color-mix(in oklab, ${color} 16%, transparent)` }} />
        {pct > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct)}
            style={{ stroke: color, transition: "stroke-dashoffset 600ms ease-out" }}
          />
        )}
      </svg>
      {children && <div className="absolute inset-0 grid place-items-center">{children}</div>}
    </div>
  );
}

/** Thin linear bar in the item's identity colour (for compact lists). */
export function ColorBar({ value, color, label, className }: { value: number; color: string; label: string; className?: string }) {
  const pct = Math.max(0, Math.min(100, (Number.isFinite(value) ? value : 0) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full", className)}
      style={{ backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)` }}
    >
      <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}
