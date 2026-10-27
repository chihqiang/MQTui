/**
 * 视觉语言的三根柱子：字号、语义色、窗口尺寸。
 *
 * 这些规则过去散在各组件里：129 处 `text-[11px]`、几十处裸色号 `sky-600`、
 * 正文和表头只差 2px。改一次品牌色要 grep 全库，改一次字号靠肉眼对齐，
 * 而 window 默认 800×600 比自己的窄屏阈值 900 还小 —— 一打开 App 就是降级档。
 *
 * 全部抽成纯函数 + 一张映射表，因为「字号层级」「品牌色身份」这类东西
 * 做错了不报错，只是界面看着散。
 */

/**
 * 字号档位。五档，够用且必须够用 —— 档位一多就又回到「靠眼力对齐」。
 *
 * `micro` 是例外的一档：只给「不读、只认」的标记（快捷键 `kbd`、分组小标题、
 * 画布坐标）用，不参与信息层级。
 */
export type TextSize = "micro" | "meta" | "body" | "title" | "display";

/**
 * 字号到类名的映射。
 *
 * - `meta`（11px）：时间戳、位点、端点这类**要读**的次级信息，
 *   颜色给 slate-400 而不是 slate-500，深色底上才过得了对比度；
 * - `body`（12px）：表格单元、按钮、表单；
 * - `title`（14px）：卡片标题、弹窗标题；
 * - `display`（16px）：页面标题。原来页头也是 14px，和表头差 3px，
 *   视觉上不承担「你现在在哪」的职责。
 *
 * 走变量而不是 Tailwind 的 `text-xs/text-sm`：这两档在 Tailwind 里
 * 分别绑死 12px 和 14px，语义（meta/body/title）和尺寸（1/2/3 档）
 * 混在一起，最后还是有人写 `text-[11px]`。
 */
export const TEXT_SIZE_CLASS: Record<TextSize, string> = {
  micro: "text-(length:--text-app-micro)",
  meta: "text-(length:--text-app-meta)",
  body: "text-(length:--text-app-body)",
  title: "text-(length:--text-app-title)",
  display: "text-(length:--text-app-display)",
};

export function textSize(size: TextSize): string {
  return TEXT_SIZE_CLASS[size];
}

/**
 * 次级字号（`meta` 档）的两档取值。
 *
 * 评审里最实在的一条是「密度偏小到临界」：129 处 11px 挤在 12px 正文旁边，
 * 在 1440×900 的屏上还行，13 寸 / 高分屏缩放下就偏小。但也不能一律调大 ——
 * 一屏 30 行的信息密度是这工具立身的东西。
 *
 * 所以做成一颗开关：默认保持 11px（不变就是最好的兼容），
 * 觉得费眼的用户可以拨到 12px，全站同步。
 */
export type MetaScale = "dense" | "normal";

export const META_FONT_SIZE: Record<MetaScale, number> = {
  dense: 11,
  normal: 12,
};

export const META_OPTIONS: { value: MetaScale; label: string; hint: string }[] = [
  { value: "dense", label: "密", hint: "次级文字 11px，一屏信息最多（默认）" },
  { value: "normal", label: "舒", hint: "次级文字 12px，时间戳与位点更好读" },
];

export const DEFAULT_META_SCALE: MetaScale = "dense";

export function isMetaScale(value: unknown): value is MetaScale {
  return value === "dense" || value === "normal";
}

/** 写到 `--text-app-meta` 上的实际值（带单位）。 */
export function metaFontSize(scale: MetaScale): string {
  return `${META_FONT_SIZE[scale]}px`;
}

/**
 * 状态条密度。
 *
 * `HealthBar` 是全站唯一常驻的「一块内容」：它顶着页面标题，一旦它厚，
 * 每页的第一行数据就被往下推。紧凑档把它压成一条 16px 的细线，
 * 宽松档给 24px 放得下名称。默认紧凑 —— 面板里纵向空间比横向金贵。
 */
export type StatusDensity = "compact" | "comfortable";

export const STATUS_DENSITY_OPTIONS: { value: StatusDensity; label: string; hint: string }[] = [
  { value: "compact", label: "紧凑", hint: "一条细线，纵向空间全留给表格（默认）" },
  { value: "comfortable", label: "宽松", hint: "放得下连接名与版本号" },
];

export const DEFAULT_STATUS_DENSITY: StatusDensity = "compact";

export function isStatusDensity(value: unknown): value is StatusDensity {
  return value === "compact" || value === "comfortable";
}

export function statusBarHeight(density: StatusDensity): number {
  return density === "compact" ? 16 : 24;
}

/**
 * 中间件的身份色。
 *
 * 这段被改过两次，第二次才是对的：
 * 1. 最初 Kafka 用 `info`（sky）、RabbitMQ 用 `warning`（amber）—— amber 是告警色，
 *    RabbitMQ 因此看着像「这个连接有问题」；
 * 2. 改成 sky / violet 之后语义正了，但 Kafka 拿走的那个 sky 正是全站的 `info`
 *    —— 徽标旁一条「信息」提示和「这是一台 Kafka」是同一个颜色。
 *
 * 所以身份色必须是**独立**的一对：不借告警色，也不借提示色。
 */
export type BrokerIdentity = "kafka" | "rabbitmq" | "unknown";

export type BrokerKindName = "kafka" | "rabbitMq";

/** 身份色专属名词（对应 `--color-broker-*`），不使用任何语义 tone。 */
export type BrokerTone = "broker-kafka" | "broker-rabbitmq";

/** 身份色只用于徽标与图标底色，不参与告警 / 提示语义。 */
export const BROKER_IDENTITY_TONE: Record<BrokerKindName, BrokerTone> = {
  kafka: "broker-kafka",
  rabbitMq: "broker-rabbitmq",
};

export function brokerIdentity(kind: string): BrokerIdentity {
  if (kind === "kafka") return "kafka";
  if (kind === "rabbitMq" || kind === "rabbitmq") return "rabbitmq";
  return "unknown";
}

/**
 * 连接徽标的色调。
 *
 * 两个中间件各占一个专属色位，互不相同、且都不落在任何语义色上：
 * 用户不需要先想起来「Kafka 是哪个颜色」才能判断「这里是不是有问题」。
 */
export function brokerTone(kind: string): BrokerTone | "neutral" {
  if (kind === "kafka") return BROKER_IDENTITY_TONE.kafka;
  if (kind === "rabbitMq" || kind === "rabbitmq") return BROKER_IDENTITY_TONE.rabbitMq;
  return "neutral";
}

/**
 * 身份色不许落在语义色上（`info` / `success` / `warning` / `danger`）。
 *
 * 单测钉住它，是因为「徽标颜色」这类东西改错了没人会报 bug，只是慢慢看不清。
 */
export function isSemanticTone(tone: string): boolean {
  return ["info", "success", "warning", "danger"].includes(tone);
}

/**
 * 窗口默认尺寸。
 *
 * 两个约束：
 * 1. 必须大于 `NARROW_WIDTH`（900），否则一启动就被强制降级成极简档，
 *    用户对「分组/平铺/极简」三档的第一印象就是「按钮是灰的」；
 * 2. 必须放得下 1440×900 这类主流笔记本屏（留出标题栏与任务栏）。
 *
 * 1200×800 是这两条的交点：分组档（连接列表 208 + 菜单 144）之外还有 848px
 * 给表格，一屏能放下六列。
 */
export const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 } as const;

/** 最小窗口尺寸。低于它连极简档的两列都排不开，拖到更小就没有意义了。 */
export const MIN_WINDOW_SIZE = { width: 720, height: 480 } as const;

/**
 * 首次启动该给多大窗口。
 *
 * 记不清用户上次拖到多大（那是窗口管理器的事），但**第一次**不该给一个
 * 比自家窄屏阈值还小的尺寸。已经在存储里留过偏好的用户沿用默认值，
 * 不必为老用户改窗口大小。
 */
export function initialWindowSize(): { width: number; height: number } {
  return { ...DEFAULT_WINDOW_SIZE };
}

/** 尺寸是否放得下分组档（即不会一启动就降级）。 */
export function fitsLayout(width: number, narrowWidth: number): boolean {
  return width >= narrowWidth;
}
