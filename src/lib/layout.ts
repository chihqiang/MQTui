/**
 * 外壳布局：侧栏形态、连接分组、窄屏降级。
 *
 * 抽成纯函数的原因和 `list-view` 一样：这些规则做错了不报错，只是用起来别扭。
 * 典型的三处：
 *
 * 1. **两列侧栏各占一份宽度**。早先是「连接列表 224 + 菜单 144」并排，
 *    窗口缩到 1200px 就有 30% 的宽度不在看数据。现在合成一列 232px：
 *    连接列表是该列的一节，当前连接的页面菜单在同一列里展开。
 * 2. **连接不做顶部 Tab**。Tab 的形态要求「几个字宽、数量少、地位平行」，
 *    而连接带着名字和端点（`kafka-prod · 10.0.1.12:9092`），五条就排不下 ——
 *    这不是 Tab 该承担的密度。所以在侧栏里用「树 + 折叠」。
 * 3. **健康条和页面标题各说一句「连接状态」**。全绿时那行是纯占位，
 *    异常时才该占位置。
 */

/** 侧边栏形态。 */
export type LayoutMode = "sidebar" | "rail";

export const DEFAULT_LAYOUT: LayoutMode = "sidebar";

/** 窄屏阈值。低于此宽度一律降级为图标条。 */
export const NARROW_WIDTH = 900;

/**
 * 布局只有一个来源：窗口宽度。
 *
 * 这里曾经是一份「偏好」——三档任选、存进 localStorage、跨启动保留。
 * 但它调的是外壳本身：换个档位，连接列表、菜单、内容区全都换一遍位置，
 * 而面板工具的用法其实只有一个正确答案 —— 够宽就给侧栏，不够就收成图标条。
 * 窗口宽度是那个答案，它不需要用户来确认。
 */
export function resolveLayout(width: number | null): LayoutMode {
  // 宽度还没测出来（首帧）时按侧栏渲染：先铺一版正确的再改，
  // 好过先按窄屏铺一列再展开成两列那种整屏跳动。
  if (width === null) return DEFAULT_LAYOUT;
  return width < NARROW_WIDTH ? "rail" : DEFAULT_LAYOUT;
}

/**
 * 连接按中间件分组。
 *
 * 侧栏把「Kafka」和「RabbitMQ」各自收成一个折叠组：两种中间件的能力清单
 * 完全不同，混在一列里排下来，用户点「主题」时得先确认自己在哪个组。
 * 组内保持后端给的原顺序（最近一次连上的在前），不重排。
 */
export function groupConnectionsByKind<T extends { kind: string }>(
  connections: T[],
): { kind: string; items: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const connection of connections) {
    const bucket = buckets.get(connection.kind);
    if (bucket) bucket.push(connection);
    else buckets.set(connection.kind, [connection]);
  }
  return [...buckets.entries()].map(([kind, items]) => ({ kind, items }));
}

/**
 * 侧栏当前该展开哪个连接。
 *
 * 只有「正在看的那条」有页面菜单：五条连接各摊一份菜单等于把 13 项乘 5，
 * 而面板工具的实际上限是「同时对照两条」，切换靠的是点另一条连接。
 * 没有选中连接时（连接页）谁都不展开。
 */
export function expandedConnectionId(connectionId: string | undefined): string | null {
  return connectionId ?? null;
}

/**
 * 组是否展开。
 *
 * `set` 里存的是「与默认状态相反」的那几个键：一条连接都没有的组本来就不渲染，
 * 有连接的组默认展开。用户折起来只影响他自己，不影响默认值 ——
 * 存「展开的那几个」会在连接增删之后把新连接一直藏在折叠里。
 */
export function isGroupExpanded(collapsed: ReadonlySet<string>, key: string): boolean {
  return !collapsed.has(key);
}

/** 窄屏（图标条）时侧栏宽度。 */
export const RAIL_WIDTH = 56;

/** 侧栏宽度（含边框）。比旧的「连接 224 + 菜单 144」少一半，还多装了页面菜单。 */
export const SIDEBAR_WIDTH = 232;

/** 菜单分组。 */
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
