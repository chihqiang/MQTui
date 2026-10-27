import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { Tone } from "@/types/tone";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-slate-800 text-slate-300",
  info: "bg-sky-500/15 text-sky-300",
  success: "bg-emerald-500/15 text-emerald-300",
  warning: "bg-amber-500/15 text-amber-300",
  danger: "bg-rose-500/15 text-rose-300",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-4",
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}
