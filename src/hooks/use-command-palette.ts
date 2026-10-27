import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { buildNavItems, connectionPath } from "@/lib/nav";

import {
  clampSelection,
  type Command,
  isMacPlatform,
  isPaletteShortcut,
  isTypingTarget,
  moveSelection,
  rankCommands,
} from "@/lib/command-palette";
import { orderByRecent, pushRecent } from "@/lib/command-history";
import { LAYOUT_OPTIONS } from "@/lib/layout";
import { DENSITY_OPTIONS } from "@/lib/list-view";
import { usePreferences } from "@/hooks/use-preferences";
import { STORAGE_KEYS, guards, readJson, writeJson } from "@/lib/storage";
import { useConnections } from "@/hooks/use-connections";
import { useCapabilities } from "@/hooks/use-plugin-kinds";
import { useCommandStore, useSessionStore } from "@/stores";

/**
 * 命令面板的状态与命令清单。
 *
 * 命令由「当前连接的菜单 + 已建立的连接 + 全局动作」组成，菜单部分直接复用
 * `buildNavItems`，加中间件时这里不用改。
 */
export function useCommandPalette() {
  const query = useSessionStore((state) => state.commandQuery);
  const selected = useSessionStore((state) => state.commandSelection);
  const setQuery = useSessionStore((state) => state.setCommandQuery);
  const setSelected = useSessionStore((state) => state.setCommandSelection);
  const reset = useSessionStore((state) => state.resetCommandState);
  const visible = useCommandStore((state) => state.visible);
  const open = useCommandStore((state) => state.open);
  const close = useCommandStore((state) => state.close);
  const toggle = useCommandStore((state) => state.toggle);

  const navigate = useNavigate();
  const { connectionId } = useParams();

  // 最近用过的命令 id。读一次放 state：面板一打开就要按它排序，
  // 每次搜索都去读 localStorage 属于没必要的同步 IO。
  const [recent, setRecent] = useState<string[]>(
    () => readJson(STORAGE_KEYS.recentCommands, guards.array(guards.string)) ?? [],
  );
  const { data: connections } = useConnections();
  const current = connections?.find((item) => item.id === connectionId);
  const capabilities = useCapabilities(current?.kind);
  const [preferences, updatePreferences] = usePreferences();

  const commands = useMemo<Command[]>(() => {
    // 只展开当前连接的菜单。跨连接的菜单用「切换到 X」命令表达，
    // 否则九项菜单乘以 N 个连接，搜什么都要先跨过一堆重名项。
    const menuCommands: Command[] = current
      ? buildNavItems(capabilities).map((item) => ({
          id: `${current.id}:${item.capability}`,
          title: item.label,
          group: current.name,
          keywords: [item.description, ...item.keywords, current.endpoint],
          run: () => navigate(connectionPath(current.id, item.capability)),
        }))
      : [];

    // 连接命令始终保留：没选连接时它是唯一的出口，选了连接时它是「换一台看」的捷径。
    const connectionCommands: Command[] = (connections ?? []).map((item) => ({
      id: `connection:${item.id}`,
      title: `切换到 ${item.name}`,
      group: "连接",
      // 地址是最好的搜索词：记得住端口，记不住连接名。
      keywords: [item.endpoint, item.kind === "kafka" ? "kafka" : "rabbitmq"],
      run: () => navigate(connectionPath(item.id)),
    }));

    // 动作命令：开关类的设置项也收进面板，不用为此再加一个设置页或一排图标。
    // 只列出「另一个档位」，用户看到的就是按下去会发生什么。
    const densityCommands: Command[] = DENSITY_OPTIONS.filter(
      (option) => option.value !== preferences.density,
    ).map((option) => ({
      id: `global:density:${option.value}`,
      title: `表格密度改为「${option.label}」`,
      group: "显示",
      keywords: ["density", "row height", "miji", "hanggao", option.hint],
      run: () => updatePreferences({ density: option.value }),
    }));

    // 布局同理：只列另外两档。窗口太窄时改这里不会生效，所以干脆不列，
    // 免得用户点完发现「什么都没变」。
    const layoutCommands: Command[] = LAYOUT_OPTIONS.filter(
      (option) => option.value !== preferences.layout,
    ).map((option) => ({
      id: `global:layout:${option.value}`,
      title: `侧边栏布局改为「${option.label}」`,
      group: "显示",
      keywords: ["layout", "sidebar", "nav", "buju", "celan", option.hint],
      run: () => updatePreferences({ layout: option.value }),
    }));

    const globalCommands: Command[] = [
      ...densityCommands,
      ...layoutCommands,
      {
        id: "global:new-connection",
        title: "新建连接",
        group: "全局",
        keywords: ["connect", "open", "xinjianlianjie", "xjlj"],
        run: () => navigate("/"),
      },
    ];

    return [...menuCommands, ...connectionCommands, ...globalCommands];
  }, [
    capabilities,
    connections,
    current,
    navigate,
    preferences.density,
    preferences.layout,
    updatePreferences,
  ]);

  /**
   * 空查询时按最近使用排序：打开面板的第一屏就该是「我天天点的那几个」。
   * 有查询词时保持匹配得分的顺序 —— 用户已经在打字了，历史记录不该插队。
   */
  const ordered = useMemo(
    () => (query.trim() ? commands : orderByRecent(commands, recent)),
    [commands, query, recent],
  );

  const matches = useMemo(() => rankCommands(ordered, query), [ordered, query]);

  // 结果集变化后把选中项收敛回范围内，避免「选中第 5 项、结果只剩 2 项」时回车落空。
  useEffect(() => {
    setSelected(clampSelection(selected, matches.length));
  }, [matches.length, selected, setSelected]);

  // 全局快捷键：⌘K / Ctrl+K 开关面板。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 面板打开时 Esc 关闭，交给这里统一处理，输入框不必各自记一遍。
      if (visible && event.key === "Escape") {
        close();
        return;
      }
      if (!isPaletteShortcut(event, isMacPlatform())) return;
      // 输入框里的 Ctrl+K 是编辑器的习惯动作，不该抢过来弹面板。
      if (!visible && isTypingTarget(event.target)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, toggle, visible]);

  // 关闭时清空搜索词与选中项：留下半截搜索词只会让下次打开的人困惑。
  useEffect(() => {
    if (!visible) reset();
  }, [reset, visible]);

  const runAt = (index: number) => {
    const target = matches[index]?.command;
    if (!target) return;
    // 先关面板再执行：命令本身可能就是一次导航，留着会盖住结果页。
    close();
    const next = pushRecent(recent, target.id);
    setRecent(next);
    writeJson(STORAGE_KEYS.recentCommands, next);
    target.run();
  };

  const onQueryChange = (value: string) => {
    setQuery(value);
    // 换了搜索词，选中项回到第一条，而不是停在上一次的第 N 条。
    setSelected(0);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelected(moveSelection(selected, delta, matches.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runAt(selected);
    }
  };

  return {
    visible,
    open,
    close,
    query,
    onQueryChange,
    selected,
    setSelected,
    matches,
    onKeyDown,
    runAt,
  };
}
