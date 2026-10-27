/**
 * 外壳布局：三种形态、分组规则与窄屏降级。
 *
 * 抽成纯函数的原因和 `list-view` 一样：这些规则做错了不报错，只是用起来别扭。
 * 典型的三处：
 *
 * 1. **窄屏下侧边栏和内容抢宽度**。连接名、端点、队列名都长，窗口缩到 900px
 *    时「连接列表 224 + 菜单 144」吃掉 40% 的宽度，表格只剩两列。
 * 2. **菜单平铺 13 项**。RabbitMQ 的能力清单正好 13 个，一列排下来密不透风，
 *    「队列」和「策略」在视觉上属于同一个层级，实际一个是日常、一个是配置。
 * 3. **健康条和页面标题各说一句「连接状态」**。全绿时那行是纯占位，
 *    异常时才该占位置。
 */

/** 侧边栏形态。`grouped` = 连接列表 + 按组分段的菜单。 */
export type LayoutMode = "grouped" | "classic" | "collapsed";

export const LAYOUT_OPTIONS: { value: LayoutMode; label: string; hint: string }[] = [
  { value: "grouped", label: "分组", hint: "连接列表 + 按用途分组的菜单，一眼分得出日常页和配置页" },
  { value: "classic", label: "平铺", hint: "连接列表 + 单列菜单，项目最少，最省宽度" },
  { value: "collapsed", label: "极简", hint: "侧边栏收成图标条，宽度全给表格" },
];

export const DEFAULT_LAYOUT: LayoutMode = "grouped";

/** 窄屏阈值。低于此宽度一律降级为极简。 */
export const NARROW_WIDTH = 900;

/**
 * 布局只有一个来源：窗口宽度。
 *
 * 这里曾经是一份「偏好」——三档任选、存进 localStorage、跨启动保留。
 * 但它调的是外壳本身：换个档位，连接列表、菜单、内容区全都换一遍位置，
 * 而面板工具的用法其实只有一个正确答案 —— 够宽就给菜单，不够就收成图标条。
 * 窗口宽度是那个答案，它不需要用户来确认。
 * 一个「能改但没人愿意改」的开关，代价是每次打开都要判断「我现在是哪档」。
 */
export function resolveLayout(width: number | null): LayoutMode {
  // 宽度还没测出来（首帧）时按分组渲染：先铺一版正确的再改，
  // 好过先按窄屏铺一列再展开成两列那种整屏跳动。
  if (width === null) return DEFAULT_LAYOUT;
  return width < NARROW_WIDTH ? "collapsed" : DEFAULT_LAYOUT;
}

/** 菜单分组。`null` 表示不分组（平铺形态）。 */
export type NavGroup = "operate" | "observe" | "config";

export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  operate: "消息",
  observe: "观测",
  config: "配置",
};

export const NAV_GROUP_ORDER: NavGroup[] = ["operate", "observe", "config"];

/**
 * 能力到分组的映射。
 *
 * 分组依据是「用它的频率」而不是「它属于哪个概念」：
 * 主题 / 队列 / 消息是天天点的，拓扑图和无消费组是排查时才打开的，
 * 策略 / 参数 / 位点重置是改一次就很久不碰的。按概念分会把
 * 「主题」和「消费组」放一组，但这两件事的使用场景完全不同。
 */
const CAPABILITY_GROUP: Record<string, NavGroup> = {
  topics: "operate",
  queues: "operate",
  messages: "operate",
  produce: "operate",
  consumerGroups: "operate",
  consumers: "operate",
  exchanges: "operate",

  overview: "observe",
  cluster: "observe",
  runtime: "observe",
  orphanTopics: "observe",
  topologyGraph: "observe",
  consumerGraph: "observe",
  routing: "observe",

  policies: "config",
  parameters: "config",
  offsetReset: "config",
};

export function navGroupOf(capability: string): NavGroup {
  return CAPABILITY_GROUP[capability] ?? "observe";
}

/**
 * 把菜单项按分组切开，保持后端给的原顺序。
 *
 * 空组直接丢弃：Kafka 没有「策略」，界面上就不该留一个空标题。
 * 只返回一条的组也不加标题（`single` 标记留给调用方判断）——
 * 为一个菜单项加一行小标题，换来的只是多一层缩进。
 */
export function groupNavItems<T extends { capability: string }>(
  items: T[],
): { group: NavGroup; items: T[] }[] {
  const buckets = new Map<NavGroup, T[]>();
  for (const item of items) {
    const group = navGroupOf(item.capability);
    const bucket = buckets.get(group);
    if (bucket) bucket.push(item);
    else buckets.set(group, [item]);
  }
  return NAV_GROUP_ORDER.filter((group) => buckets.has(group)).map((group) => ({
    group,
    items: buckets.get(group) ?? [],
  }));
}
