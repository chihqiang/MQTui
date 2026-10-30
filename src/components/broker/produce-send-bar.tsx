import { Button } from "@/components/ui";

/**
 * 发送条的快捷键文案。
 *
 * 显示 `⌘↵` 还是 `Ctrl+↵` 得看平台 —— 在 Windows 上写 `⌘` 等于告诉用户
 * 「这个键你的键盘上没有」。`navigator.platform` 已废弃但仍是最省事的判据，
 * 取不到时退回 `Ctrl+↵`（macOS 用户看到 `Ctrl` 也照样按得出来）。
 */
export function submitShortcutLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl+↵";
  const platform = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad/.test(platform) ? "⌘↵" : "Ctrl+↵";
}

/**
 * 发送条：常驻在卡片底部。
 *
 * 这一条存在的理由是「发送是这一页唯一的主动作，不该需要滚动才能按到」。
 * 左边永远说清当前状态 —— 能发时说数据量，不能发时说**为什么不**；
 * 把「再滚回去看看是哪一格没填」这件事从界面上删掉。
 */
export function ProduceSendBar({
  blocked,
  meta,
  submitting,
  label = "发送",
}: {
  /** 当前发不出去的原因；有值时按钮置灰并显示这句话。 */
  blocked: string | null;
  /** 可发送时的状态说明（字节数 + 快捷键）。 */
  meta: string;
  submitting: boolean;
  label?: string;
}) {
  return (
    // `sticky bottom-0`：内容再长，这条也贴在滚动区底部。
    // 半透明 + 模糊是为了让下面的表单内容在滚过时仍然隐约可见 ——
    // 一整条不透明的白底会把正文「切断」，看起来像页面结束了。
    <div className="sticky bottom-0 flex items-center gap-3 rounded-b-xl border-t border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur-sm">
      <span
        className={
          blocked
            ? "min-w-0 flex-1 truncate text-(length:--text-app-meta) text-amber-700"
            : "min-w-0 flex-1 truncate text-(length:--text-app-meta) text-slate-500"
        }
      >
        {blocked ?? meta}
      </span>
      <Button type="submit" loading={submitting} disabled={Boolean(blocked)}>
        {label}
      </Button>
    </div>
  );
}
