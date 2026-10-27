import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl bg-white ring-1 ring-slate-200", className)}
      {...props}
    />
  );
}

export function CardHeader({ title, extra }: { title: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
      <h2 className="min-w-0 truncate text-(length:--text-app-title) font-medium text-slate-800">{title}</h2>
      {extra ? <div className="flex shrink-0 items-center gap-2">{extra}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />;
}
