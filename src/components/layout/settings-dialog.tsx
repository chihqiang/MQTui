import { useEffect } from "react";

import { Modal, Segmented } from "@/components/ui";
import { cn } from "@/lib/cn";
import { usePreferences } from "@/hooks/use-preferences";
import { isMacPlatform, isSettingsShortcut, isTypingTarget } from "@/lib/command-palette";
import { LAYOUT_OPTIONS, NARROW_WIDTH, resolveLayout, type LayoutMode } from "@/lib/layout";
import { DENSITY_OPTIONS, type Density } from "@/lib/list-view";
import { PAGE_SIZE_OPTIONS, resolvePageSize } from "@/lib/page-size";
import { useViewportWidth } from "@/hooks/use-viewport";
import {
  META_OPTIONS,
  STATUS_DENSITY_OPTIONS,
  metaFontSize,
  statusBarHeight,
  textSize,
  type MetaScale,
  type StatusDensity,
} from "@/lib/visual";

/**
 * 偏好设置弹窗：布局 + 表格密度。
 *
 * 这两项以前只存在于两处：命令面板的命令行里，和「只在表格底部显示当前密度」
 * 的那行字里 —— 后者尤其像个玩笑：它告诉用户「当前表格密度：紧凑」，
 * 却没有任何地方能改它。用户摸得到的能力才是能力，摸不到的叫隐藏开关。
 *
 * 为什么是弹窗而不是设置页：只有两档选项，开一页等于让用户在自己都不确定
 * 有什么的地方找东西。入口放三处：齿轮按钮（可发现）、⌘/Ctrl+, （好记）、
 * 命令面板（已经习惯了用键盘找东西的人）。
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [preferences, updatePreferences] = usePreferences();
  const width = useViewportWidth();
  const narrow = width > 0 && width < NARROW_WIDTH;

  // ⌘, / Ctrl+, 开关弹窗。挂在 window 上而不是弹窗内：弹窗关着时也要能开。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSettingsShortcut(event, isMacPlatform())) return;
      // 输入框里的 Ctrl+, 没有系统含义，但抢过来会让人莫名其妙。
      if (!open && isTypingTarget(event.target)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  // 窄屏下布局被强制极简，改「布局」不会立刻生效 —— 与其让它当个哑开关，
  // 不如照实说。偏好照存，窗口拉宽就生效。
  const effective = resolveLayout(preferences.layout, width);

  return (
    <Modal open={open} title="偏好设置" onClose={onClose} size="sm">
      <div className="flex flex-col gap-5">
        <Section
          label="侧边栏布局"
          hint={
            narrow
              ? `窗口窄于 ${NARROW_WIDTH}px，已强制收起为「极简」。拉宽窗口后按这里的选择生效。`
              : "分组按用途分段，平铺最省宽度，极简把宽度全留给表格。"
          }
          note={narrow ? `当前生效：${labelOf(LAYOUT_OPTIONS, effective)}` : undefined}
        >
          <Segmented
            options={LAYOUT_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              title: option.hint,
            }))}
            value={preferences.layout}
            onChange={(layout: LayoutMode) => updatePreferences({ layout })}
          />
        </Section>

        <Section label="表格密度" hint="全站一致：翻页面时视线不用重新适应。">
          <Segmented
            options={DENSITY_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              title: option.hint,
            }))}
            value={preferences.density}
            onChange={(density: Density) => updatePreferences({ density })}
          />
        </Section>

        <Section
          label="次级字号"
          hint="时间戳、位点、端点这类文字。面板里这类文字最多，也最容易看累。"
          note={`当前：${metaFontSize(preferences.metaScale)}`}
        >
          <Segmented
            options={META_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              title: option.hint,
            }))}
            value={preferences.metaScale}
            onChange={(metaScale: MetaScale) => updatePreferences({ metaScale })}
          />
        </Section>

        <Section
          label="消息分页"
          hint="一次读多少条。调大后翻页次数变少，但每次加载更慢、更占内存。"
          note={`当前：一页 ${resolvePageSize(preferences.pageSize)} 条`}
        >
          <Segmented
            options={PAGE_SIZE_OPTIONS.map((option) => ({
              value: String(option.value),
              label: option.label,
              title: option.hint,
            }))}
            value={String(resolvePageSize(preferences.pageSize))}
            onChange={(value: string) => updatePreferences({ pageSize: Number(value) })}
          />
        </Section>

        <Section
          label="状态条"
          hint="连接健康状态那条横栏。它常驻在每页标题上方，厚一点就少一行表格。"
          note={`当前：${statusBarHeight(preferences.statusDensity)}px`}
        >
          <Segmented
            options={STATUS_DENSITY_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              title: option.hint,
            }))}
            value={preferences.statusDensity}
            onChange={(statusDensity: StatusDensity) => updatePreferences({ statusDensity })}
          />
        </Section>
      </div>
    </Modal>
  );
}

function Section({
  label,
  hint,
  note,
  children,
}: {
  label: string;
  hint: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <h4 className={cn(textSize("body"), "font-medium text-slate-800")}>{label}</h4>
        {children}
      </div>
      <p className={cn(textSize("meta"), "text-slate-500")}>{hint}</p>
      {note ? <p className={cn(textSize("meta"), "text-meta")}>{note}</p> : null}
    </section>
  );
}

function labelOf<T extends string>(options: { value: T; label: string }[], value: T): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
