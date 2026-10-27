import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { BadgeTone } from "@/types/tone";

/**
 * 徽标底色统一是「语义色 15% + 浅色文字」，一处登记就够了。
 *
 * `broker-kafka` / `broker-rabbitmq` 是身份色：它们不表达任何告警或提示语义，
 * 所以既不借 amber/rose（会被读成有问题），也不借 sky（会和「信息」撞脸）。
 */
const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-slate-800 text-slate-300",
  info: "bg-info/15 text-info",
  accent: "bg-accent/15 text-accent",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  "broker-kafka": "bg-broker-kafka/15 text-broker-kafka",
  "broker-rabbitmq": "bg-broker-rabbitmq/15 text-broker-rabbitmq",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-(length:--text-app-meta) leading-4",
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}
