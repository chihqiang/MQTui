import type { BrokerCapability, BrokerKind } from "@/types";

/** 侧边栏菜单项描述。菜单由「能力」驱动，而不是按中间件写死。 */
export interface NavItem {
  capability: BrokerCapability;
  label: string;
  /** 相对路径片段，最终路径为 `/connections/:id/:path`。 */
  path: string;
}

const NAV_LABELS: Record<BrokerCapability, { label: string; path: string }> = {
  overview: { label: "概览", path: "overview" },
  topics: { label: "主题", path: "topics" },
  consumerGroups: { label: "消费组", path: "consumer-groups" },
  orphanTopics: { label: "无消费组", path: "orphan-topics" },
  queues: { label: "队列", path: "queues" },
  exchanges: { label: "交换机", path: "exchanges" },
  messages: { label: "消息", path: "messages" },
  produce: { label: "发送消息", path: "produce" },
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
