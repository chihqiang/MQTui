import type { ReactElement } from "react";

import {
  IconCluster,
  IconConfig,
  IconExchanges,
  IconGraph,
  IconGroups,
  IconMessages,
  IconOverview,
  IconProduce,
  IconQueues,
  IconRouting,
  IconRuntime,
  IconSliders,
  IconTopics,
  IconTopology,
  IconKafka,
  IconRabbitMq,
} from "@/lib/icons";
import { brokerMark } from "@/lib/visual";
import type { BrokerCapability, BrokerKind } from "@/types";

/** 图标组件的形状。只约束尺寸与配色，形状本身由 `lib/icons` 决定。 */
export type NavIcon = (props: { size?: number; className?: string }) => ReactElement;

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
  /** 菜单项的图标。图标条形态下它是唯一的识别物，所以每个能力都必须有。 */
  Icon: NavIcon;
}

/**
 * 能力的展示信息。
 *
 * `keywords` 是搜索别名：命令面板里输入 `queue`、`queue` 的拼音首字母
 * 也能找到「队列」，不用先记住中文菜单名。
 */
const NAV_LABELS: Record<
  BrokerCapability,
  Omit<NavItem, "capability">
> = {
  overview: {
    label: "概览",
    path: "overview",
    description: "集群与连接的基础信息",
    keywords: ["overview", "gailan", "info"],
    Icon: IconOverview,
  },
  cluster: {
    label: "集群",
    path: "cluster",
    description: "节点列表、存活状态与一致性报警",
    keywords: ["cluster", "brokers", "nodes", "jiqun", "jq", "node"],
    Icon: IconCluster,
  },
  runtime: {
    label: "连接",
    path: "runtime",
    description: "AMQP 连接、通道与队列位置",
    keywords: ["connections", "channels", "runtime", "lianjie", "lj", "td"],
    Icon: IconRuntime,
  },
  topics: {
    label: "主题",
    path: "topics",
    description: "Kafka 主题列表与容量分布",
    keywords: ["topics", "topic", "zhuti", "zt"],
    Icon: IconTopics,
  },
  consumerGroups: {
    label: "消费组",
    path: "consumer-groups",
    description: "消费组与分区滞后量",
    keywords: ["consumer groups", "group", "lag", "xiaofeizu", "xfz"],
    Icon: IconGroups,
  },
  offsetReset: {
    label: "位点重置",
    path: "offset-reset",
    description: "生成位点对照表后重置消费组进度",
    keywords: ["offset", "reset", "seek", "weidian", "wdz"],
    Icon: IconGraph,
  },
  orphanTopics: {
    label: "无消费组",
    path: "orphan-topics",
    description: "有堆积但无人消费的主题",
    keywords: ["orphan", "no consumer", "wuxiaofeizu", "wxfz"],
    Icon: IconGraph,
  },
  queues: {
    label: "队列",
    path: "queues",
    description: "RabbitMQ 队列列表与堆积情况",
    keywords: ["queues", "queue", "duilie", "dl"],
    Icon: IconQueues,
  },
  policies: {
    label: "策略",
    path: "policies",
    description: "TTL、死信、长度上限与镜像规则下发",
    keywords: ["policies", "policy", "ttl", "dead letter", "mirror", "celue", "cl"],
    Icon: IconConfig,
  },
  parameters: {
    label: "参数",
    path: "parameters",
    description: "联邦、铲子与运行时参数",
    keywords: ["parameters", "parameter", "federation", "shovel", "upstream", "canshu", "cs"],
    Icon: IconSliders,
  },
  exchanges: {
    label: "交换机",
    path: "exchanges",
    description: "交换机与绑定关系",
    keywords: ["exchanges", "exchange", "binding", "jiaohuanji", "jhj"],
    Icon: IconExchanges,
  },
  consumers: {
    label: "消费者",
    path: "consumers",
    description: "队列与消费者的连线、预取与未确认情况",
    keywords: ["consumers", "consumer", "channel", "prefetch", "xiaofeizhe", "xfz"],
    Icon: IconGroups,
  },
  topologyGraph: {
    label: "拓扑图",
    path: "topology",
    description: "交换机与队列的分层连线图",
    keywords: ["topology", "graph", "map", "tuopu", "tp"],
    Icon: IconTopology,
  },
  consumerGraph: {
    label: "消费链路",
    path: "consumer-graph",
    description: "交换机 → 队列 → 消费者连接的整条链路",
    keywords: ["consumer graph", "link", "connection", "xiaofei lianlu", "xfl"],
    Icon: IconRouting,
  },
  routing: {
    label: "路由估算",
    path: "routing",
    description: "交换机到队列的可达性与死路排查",
    keywords: ["routing", "route", "dead letter", "luyou", "ly"],
    Icon: IconRouting,
  },
  messages: {
    label: "消息",
    path: "messages",
    description: "浏览、定位与处置消息",
    keywords: ["messages", "message", "xiaoxi", "xx"],
    Icon: IconMessages,
  },
  produce: {
    label: "发送消息",
    path: "produce",
    description: "向 topic 或 exchange 投递一条消息",
    keywords: ["produce", "send", "publish", "fasong", "fs"],
    Icon: IconProduce,
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

/**
 * 中间件图标。
 *
 * 两个形状都是商标级差异（齿轮状叶片 / 长耳朵），16px 下也认得出 ——
 * 而「Kafka 是琥珀色、RabbitMQ 是紫色」这件事，得先记住颜色才用得上。
 * 形状解决「这是哪种中间件」，颜色继续解决「我在哪一条连接上」。
 *
 * 未知类型退回 `null`：宁可不画，也别拿一个通用图标冒充品牌。
 */
export const BROKER_ICON: Record<string, NavIcon | null> = {
  kafka: IconKafka,
  rabbitmq: IconRabbitMq,
};

export function brokerIcon(kind: string): NavIcon | null {
  return BROKER_ICON[brokerMark(kind)] ?? null;
}
