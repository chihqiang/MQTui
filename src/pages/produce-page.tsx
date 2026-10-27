import { useSearchParams } from "react-router";

import { Card, CardBody } from "@/components/ui";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { useActiveConnection } from "@/hooks/use-active-connection";
import { KafkaProduceForm } from "./produce/kafka-produce-form";
import { RabbitProduceForm } from "./produce/rabbit-produce-form";

/**
 * 发送消息：按连接类型分成两张表单。
 *
 * 上一版是「一张表单 + 把不适用的格子置灰」：Kafka 下留一个永远灰着的 exchange 框，
 * RabbitMQ 下留一个用不上的 key 框，提示里再解释一遍「这一格你不用管」。
 * 那不是在照顾两种中间件，而是在替用户记住哪些字段是废的。
 *
 * 两种协议要填的东西本来就不一样 —— Kafka 是 topic + key，RabbitMQ 是
 * exchange + routing key + 投递模式 + headers。分开之后，页面上每个格子都有用。
 */
export function ProducePage() {
  const { connection } = useActiveConnection();
  const [searchParams] = useSearchParams();
  // 从消息页带着 `?target=` 过来：那是用户刚刚在看的东西。
  const presetTarget = searchParams.get("target");

  return (
    <PageBody>
      <PageHeader
        title="发送消息"
        description="投递一条消息用于验证；payload 原样发送，不做格式化"
      />
      {connection ? (
        connection.kind === "kafka" ? (
          <KafkaProduceForm connection={connection} presetTarget={presetTarget} />
        ) : (
          <RabbitProduceForm connection={connection} presetTarget={presetTarget} />
        )
      ) : (
        <Card>
          <CardBody>
            <p className="text-(length:--text-app-body) text-slate-500">先选一个连接。</p>
          </CardBody>
        </Card>
      )}
    </PageBody>
  );
}
