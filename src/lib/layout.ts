/**
 * 外壳布局：侧栏形态、折叠键、窄屏降级。
 *
 * 抽成纯函数的原因和 `list-view` 一样：这些规则做错了不报错，只是用起来别扭。
 * 典型的两处：
 *
 * 1. **两列侧栏各占一份宽度**。早先是「连接列表 224 + 菜单 144」并排，
 *    窗口缩到 1200px 就有 30% 的宽度不在看数据。现在合成一列 232px：
 *    连接列表是该列的一节，页面菜单在同一列里跟着各自的连接。
 * 2. **连接不做顶部 Tab**。Tab 的形态要求「几个字宽、数量少、地位平行」，
 *    而连接带着名字和端点（`kafka-prod · 10.0.1.12:9092`），五条就排不下 ——
 *    这不是 Tab 该承担的密度。所以在侧栏里用「连接 + 它自己的页面」两层。
 *
 * 侧栏只要两层，所以没有「中间件分组」这一层：Kafka / RabbitMQ 的区别
 * 已经画在每条连接的徽标上（形状 + 身份色），再罩一个可折叠的分组标题，
 * 等于让人每次先点一次才看得见自己连的那些机器。
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
 * 一条连接该不该摊开自己的页面菜单。
 *
 * 侧栏只有两层：连接 → 它的页面。层级既然只剩两层，摊开 / 收起就该
 * 直接做在连接行上（见 `connection-node.tsx` 里的 `setFolded`），不再需要
 * 一个「窗口里谁被折起来了」的集合 —— 早先那份集合是为了让「折叠状态可判、
 * 可测」，可它也带来了一个更贵的副作用：连接是查询结果，折叠是组件里的
 * 局部状态，两者不同步时箭头点了没反应（改了集合，列表并不重渲染）。
 *
 * 现在折叠就是行自己的事，`lib` 只留 `connectionFoldKey` 一个做持久化键。
 */

export function connectionFoldKey(connection: { kind: string; endpoint: string }): string {
  return `${connection.kind}@${connection.endpoint}`;
}

/** 窄屏（图标条）时侧栏宽度。 */
export const RAIL_WIDTH = 56;

/** 侧栏宽度（含边框）。比旧的「连接 224 + 菜单 144」少一半，还多装了页面菜单。 */
export const SIDEBAR_WIDTH = 232;
