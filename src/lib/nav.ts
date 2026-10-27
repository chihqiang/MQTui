import type { BrokerCapability, BrokerKind } from "@/types";

/** 侧边栏菜单项描述。菜单由「能力」驱动，而不是按中间件写死。 */
export interface NavItem {
  capability: BrokerCapability;
  label: string;
  /** 相对路径片段，最终路径为 `/connections/:id/:path`。 */
  path: string;
  /** 一句话说明，用于命令面板等处：名字之外还需要「这页能干什么」。 */
  description: string;
  /** 搜索别名（英文名、拼音首字母），命令面板用。 */
  keywords: string[];
}

/**
 * 能力的展示信息。
 *
 * `keywords` 是搜索别名：命令面板里输入 `queue`、`queue` 的拼音首字母
 * 也能找到「队列」，不用先记住中文菜单名。
 */
const NAV_LABELS: Record<
  BrokerCapability,
  { label: string; path: string; description: string; keywords: string[] }
> = {
  overview: {
    label: "概览",
    path: "overview",
    description: "集群与连接的基础信息",
    keywords: ["overview", "gailan", "info"],
  },
  cluster: {
    label: "集群",
    path: "cluster",
    description: "节点列表、存活状态与一致性报警",
    keywords: ["cluster", "brokers", "nodes", "jiqun", "jq", "node"],
  },
  runtime: {
    label: "连接",
    path: "runtime",
    description: "AMQP 连接、通道与队列位置",
    keywords: ["connections", "channels", "runtime", "lianjie", "lj", "td"],
  },
  topics: {
    label: "主题",
    path: "topics",
    description: "Kafka 主题列表与容量分布",
    keywords: ["topics", "topic", "zhuti", "zt"],
  },
  consumerGroups: {
    label: "消费组",
    path: "consumer-groups",
    description: "消费组与分区滞后量",
    keywords: ["consumer groups", "group", "lag", "xiaofeizu", "xfz"],
  },
  offsetReset: {
    label: "位点重置",
    path: "offset-reset",
    description: "生成位点对照表后重置消费组进度",
    keywords: ["offset", "reset", "seek", "weidian", "wdz"],
  },
  orphanTopics: {
    label: "无消费组",
    path: "orphan-topics",
    description: "有堆积但无人消费的主题",
    keywords: ["orphan", "no consumer", "wuxiaofeizu", "wxfz"],
  },
  queues: {
    label: "队列",
    path: "queues",
    description: "RabbitMQ 队列列表与堆积情况",
    keywords: ["queues", "queue", "duilie", "dl"],
  },
  policies: {
    label: "策略",
    path: "policies",
    description: "TTL、死信、长度上限与镜像规则下发",
    keywords: ["policies", "policy", "ttl", "dead letter", "mirror", "celue", "cl"],
  },
  parameters: {
    label: "参数",
    path: "parameters",
    description: "联邦、铲子与运行时参数",
    keywords: ["parameters", "parameter", "federation", "shovel", "upstream", "canshu", "cs"],
  },
  exchanges: {
    label: "交换机",
    path: "exchanges",
    description: "交换机与绑定关系",
    keywords: ["exchanges", "exchange", "binding", "jiaohuanji", "jhj"],
  },
  consumers: {
    label: "消费者",
    path: "consumers",
    description: "队列与消费者的连线、预取与未确认情况",
    keywords: ["consumers", "consumer", "channel", "prefetch", "xiaofeizhe", "xfz"],
  },
  topologyGraph: {
    label: "拓扑图",
    path: "topology",
    description: "交换机与队列的分层连线图",
    keywords: ["topology", "graph", "map", "tuopu", "tp"],
  },
  consumerGraph: {
    label: "消费链路",
    path: "consumer-graph",
    description: "交换机 → 队列 → 消费者连接的整条链路",
    keywords: ["consumer graph", "link", "connection", "xiaofei lianlu", "xfl"],
  },
  routing: {
    label: "路由估算",
    path: "routing",
    description: "交换机到队列的可达性与死路排查",
    keywords: ["routing", "route", "dead letter", "luyou", "ly"],
  },
  messages: {
    label: "消息",
    path: "messages",
    description: "浏览、定位与处置消息",
    keywords: ["messages", "message", "xiaoxi", "xx"],
  },
  produce: {
    label: "发送消息",
    path: "produce",
    description: "向 topic 或 exchange 投递一条消息",
    keywords: ["produce", "send", "publish", "fasong", "fs"],
  },
};

/** 默认落点：取能力列表中的第一项。 */
export const DEFAULT_CAPABILITY: BrokerCapability = "overview";

/** 由后端返回的能力清单生成菜单。 */
export function buildNavItems(capabilities: BrokerCapability[]): NavItem[] {
  return capabilities.map((capability) => ({
    capability,
    ...NAV_LABELS[capability],
  }));
}

/** 连接详情页路径。 */
export function connectionPath(id: string, capability: BrokerCapability = DEFAULT_CAPABILITY): string {
  return `/connections/${id}/${NAV_LABELS[capability].path}`;
}

/** 菜单高亮用的能力映射。 */
export function capabilityFromSegment(segment: string | undefined): BrokerCapability {
  const found = Object.entries(NAV_LABELS).find(([, value]) => value.path === segment);
  return (found?.[0] as BrokerCapability | undefined) ?? DEFAULT_CAPABILITY;
}

export const BROKER_LABEL: Record<BrokerKind, string> = {
  kafka: "Kafka",
  rabbitMq: "RabbitMQ",
};
