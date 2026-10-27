/**
 * 连接失败的那句话，翻成「该动哪一处」。
 *
 * 现在 toast 里是后端原文：「连接失败: 127.0.0.1:9092: Local: Broker transport failure」。
 * 这句话对写代码的人有信息量，对正在填表单的人等于没说 —— 他不知道该改地址、
 * 该找运维开端口、还是该去要口令。
 *
 * 所以这里只做一件事：把手上的错误归类成一个**可执行的动作**，并说明依据。
 * 不认识的错误原样透出，不硬编一个像模像样的结论 —— 猜错的指引比没有指引更贵。
 *
 * 纯函数，不碰 React；`kind` 来自 `AppError` 的稳定字段（见 `src-tauri/src/error.rs`）。
 */

import type { AppErrorPayload } from "./errors.ts";

/** 出错的大概率位置。用于把焦点送回去，所以只有表单里真有的字段。 */
export type FailureField = "brokers" | "host" | "port" | "auth" | "tls" | "managementUrl" | null;

export interface ConnectFailure {
  /** 一句话结论：问题在哪。 */
  summary: string;
  /** 下一步动作；`null` 表示这里给不出具体动作，只留原文。 */
  hint: string | null;
  /** 技术原文，折叠展示。 */
  detail: string;
  field: FailureField;
  /** 关键字恰好命中某条已知规则时为真，界面可以只说结论、把原文收进「详情」。 */
  known: boolean;
}

/**
 * 规则按「越具体越先」排。
 *
 * `test` 收的是**归一化后的小写消息**，规则里不要写大写。
 * 每条规则对应一次真实的踩坑，不是把常见网络错误抄一遍。
 */
const RULES: {
  /** 命中的错误原文特征（正则）。 */
  pattern: RegExp;
  summary: string;
  hint: string;
  field: FailureField;
}[] = [
  {
    pattern: /connection refused|os error 111|econnrefused/,
    summary: "这个地址上没人监听",
    hint: "确认端口与服务是否对得上：Kafka 一般 9092，RabbitMQ 的 AMQP 是 5672（15672 是管理 API 的端口）。",
    field: "port",
  },
  {
    pattern: /authentication|sasl|invalid credentials|access_refused|login was refused|401|403/,
    summary: "凭据没通过",
    hint: "先核对用户名、口令与 vhost；Kafka 还要确认 SASL 机制（PLAIN / SCRAM）和 broker 上开的一致。",
    field: "auth",
  },
  {
    pattern: /timed out|timeout|etimedout/,
    summary: "请求发出去了，没有回音",
    hint: "地址可能写对了但被防火墙或安全组挡着；也确认一下连的是内网还是需要跳板。",
    field: "brokers",
  },
  {
    pattern: /dns|name or service not known|failed to lookup|no such host|nodename nor servname/,
    summary: "这个主机名解析不出来",
    hint: "如果是 Docker 里的容器名或内网域名，本机 DNS 找不到它；换成 IP 先验证连通性。",
    field: "host",
  },
  {
    pattern: /ssl|tls|certificate|handshake/,
    summary: "握手在 TLS 这层断掉了",
    hint: "确认服务端是否真的要 TLS：面板里选了「强制 TLS」而服务端是明文，握手一定失败，反之亦然。",
    field: "tls",
  },
  {
    pattern: /vhost/,
    summary: "vhost 不存在或没权限",
    hint: "vhost 必须先在服务端建好并授权给这个用户；默认 vhost 是 `/`。",
    field: "auth",
  },
  {
    pattern: /management|15672/,
    summary: "AMQP 通了，管理 API 不通",
    hint: "队列列表依赖管理插件：确认 management 端口与地址，以及它和 AMQP 是否同一套凭据。",
    field: "managementUrl",
  },
];

/** 后端在 `AppError::Connect` 前会拼一句「连接失败: 」，对分类没有帮助，先剥掉。 */
function normalize(message: string): string {
  return message.replace(/^连接失败[:：]\s*/, "").toLowerCase();
}

/**
 * 把一次连接失败翻译成「结论 + 下一步」。
 *
 * `endpoint` 只在最末的兜底文案里用到：连哪都连不上时，人至少要知道刚才试的是哪个地址。
 */
export function connectFailure(error: AppErrorPayload, endpoint?: string): ConnectFailure {
  const detail = error.message;
  const haystack = normalize(detail);
  const rule = RULES.find((item) => item.pattern.test(haystack));

  if (rule) {
    return { summary: rule.summary, hint: rule.hint, detail, field: rule.field, known: true };
  }

  // 后端自己的分类比关键字更可靠：`invalid` 一定是参数层拦下的，不是网络。
  if (error.kind === "invalid") {
    return {
      summary: "参数没通过检查",
      hint: "按原文改一处再试，通常是地址格式或缺少必填项。",
      detail,
      field: null,
      known: true,
    };
  }

  const where = endpoint?.trim();
  return {
    summary: where ? `连不上 ${where}` : "连接没有成功",
    hint: null,
    detail,
    field: where ? "brokers" : null,
    known: false,
  };
}

/** 错误识别为「凭据」一类时，才值得把人送进对应的表单字段。 */
export function focusField(field: FailureField): void {
  if (field !== "auth" && field !== "tls") return;
  // 表单在弹窗里，等它渲染完再找；找不到就算了，光标停在原处也无伤大雅。
  window.setTimeout(() => {
    const input = document.querySelector<HTMLInputElement>(
      field === "auth" ? "input[type=password]" : "[data-field=tls]",
    );
    input?.focus();
    input?.select?.();
  }, 0);
}

/** 一句话摘要：给 toast 用，不占屏。 */
export function connectFailureLine(error: AppErrorPayload, endpoint?: string): string {
  const failure = connectFailure(error, endpoint);
  return failure.hint ? `${failure.summary} —— ${failure.hint}` : `${failure.summary}：${failure.detail}`;
}
