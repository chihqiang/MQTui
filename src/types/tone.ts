/**
 * 统一的语义色调，ui 组件与展示层映射共用。
 *
 * `accent` 与 `info` 分开是有原因的：`info` 表示「这是一条提示」，
 * `accent` 表示「这是品牌/身份色」。混用会导致整个界面只有一种强调色，
 * 而中间件的身份（Kafka / RabbitMQ）不得不借告警色 `warning` 来区分。
 */
export type Tone = "neutral" | "info" | "accent" | "success" | "warning" | "danger";

/**
 * 徽标可用的色调：语义色 + 中间件身份色。
 *
 * 身份色单独一组（`broker-*`）而不是复用 `info` / `accent`：
 * 复用之后「这是一台 Kafka」和「这是一条提示」长得一模一样，
 * 而身份色本身又不该落在任何告警语义上。
 */
export type BadgeTone = Tone | "broker-kafka" | "broker-rabbitmq";

/**
 * 「中间件身份」的色调。
 *
 * 身份色必须是独立的一对：既不借告警色（amber 会被读成「这台有问题」），
 * 也不借提示色（sky 正是全站的 `info`）。所以它既是 `Tone` 之外的一组，
 * 也是 `BadgeTone` 的一部分。放在这里而不是 `lib/visual.ts`：
 * 判断色调是数据，算出类名（`BROKER_TONE_CLASS`）才是方法。
 */
export type BrokerTone = "broker-kafka" | "broker-rabbitmq";
