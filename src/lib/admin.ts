/**
 * 账户管理（vhost / 用户 / 权限）的纯逻辑与界面判断：不发请求，可单测。
 *
 * 校验的权威实现在后端 `domain/admin.rs`，这里是它的前端影子，只回答
 * 「这一行是什么」「按钮能不能点」「确认框该说什么」。两边各写一套必然漂移，
 * 所以真正的阻断仍以后端返回为准。
 */

import type { PermissionInfo, UserInfo, UserTag, VhostRow } from "../types/admin.ts";
import { USER_TAG_HINT, USER_TAG_LABEL } from "../types/admin.ts";

/** 默认 vhost。连接串里省略 vhost 时落的就是它，删不掉。 */
export const DEFAULT_VHOST = "/";

/** 三段全开的正则。 */
export const FULL_ACCESS = ".*";

/** 解析后的标签。认不出的跳过（原文在 `tags` 里照样式显示）。 */
export function parsedTags(user: UserInfo): UserTag[] {
  return user.tags
    .map((tag) => (tag.trim() === "" ? "none" : (tag.trim() as UserTag)))
    .filter((tag) => tag in USER_TAG_LABEL);
}

/** 能不能登管理界面。空标签算「不能」——服务端不会为此报任何错。 */
export function canLogin(user: UserInfo): boolean {
  return parsedTags(user).some((tag) => tag !== "none" && tag !== "impersonator");
}

/** 是否管理员。界面上要标出来：管理员能改别人的密码。 */
export function isAdmin(user: UserInfo): boolean {
  return parsedTags(user).includes("administrator");
}

/** 标签行的展示：中文名 + 无法识别的原样保留。 */
export function describeTags(user: UserInfo): string {
  if (user.tags.length === 0) return "无";
  return user.tags
    .map((tag) => {
      const key = tag.trim();
      if (!key) return USER_TAG_LABEL.none;
      return (USER_TAG_LABEL as Record<string, string>)[key] ?? key;
    })
    .join(" · ");
}

/** 某个标签的一句话说明，用于勾选框下面。 */
export function tagHint(tag: UserTag): string {
  return USER_TAG_HINT[tag];
}

/** 该不该在「管理界面」那一列报警：能登录是正常，不能登录要显眼。 */
export function loginTone(user: UserInfo): "success" | "warning" {
  return canLogin(user) ? "success" : "warning";
}

/** 用户行的搜索匹配串。 */
export function userMatches(user: UserInfo, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  return [user.name, ...user.tags].join(" ").toLowerCase().includes(needle);
}

/** vhost 行是否被当前连接使用。 */
export function isCurrentVhost(row: VhostRow, current: string): boolean {
  return row.name === current;
}

/** 当前账号在某个 vhost 上的权限，找不到时返回 `null`。 */
export function permissionOf(
  permissions: PermissionInfo[] | null,
  user: string,
  vhost: string,
): PermissionInfo | null {
  if (!permissions) return null;
  return permissions.find((item) => item.user === user && item.vhost === vhost) ?? null;
}

/** 一段权限是不是全开。 */
export function isFullSegment(value: string): boolean {
  return value.trim() === FULL_ACCESS;
}

/** 三段是否全开。全开是「给管理员开的口子」，确认框里要单独说一句。 */
export function isFullAccess(permission: PermissionInfo): boolean {
  return (
    isFullSegment(permission.configure) &&
    isFullSegment(permission.write) &&
    isFullSegment(permission.read)
  );
}

/** 三段里空着的那些。空正则等于「什么都不许」，通常不是本意。 */
export function emptySegments(permission: PermissionInfo): string[] {
  const empty: string[] = [];
  if (!permission.configure.trim()) empty.push("configure");
  if (!permission.write.trim()) empty.push("write");
  if (!permission.read.trim()) empty.push("read");
  return empty;
}

/**
 * 撤销权限前的那句话。
 *
 * 这不是「限制访问」而是「停止访问」：撤销之后该用户在这个 vhost 上
 * 连已有的消息都读不到。正在跑的消费者会立刻掉线 —— 这句话必须写出来，
 * 否则下一次看到的是「为什么生产环境突然没有消费者了」。
 */
export function permissionRemovalWarning(permission: PermissionInfo): string {
  return (
    `撤销 ${permission.user} 在 vhost ${permission.vhost} 上的全部权限后，` +
    "该账号在这个 vhost 里什么都做不了：发不出消息、收不到消息，正在跑的消费者会立刻掉线。" +
    "权限不会自己恢复。"
  );
}

/** 删 vhost 前的提示。默认 vhost 与服务端的含糊报错都不够用，这里提前说。 */
export function vhostRemovalWarning(row: VhostRow): string {
  return (
    `删除 vhost ${row.name} 会连带删掉它里面 ${row.queues} 个队列（含其中全部消息）、` +
    `交换机、${row.permissions} 条权限与所有策略。管理 API 没有「只删空的」这个选项，` +
    "也没有回收站。这个操作不可撤销。"
  );
}

/** 删除按钮该不该禁用，以及为什么。 */
export function vhostRemovalBlock(row: VhostRow, currentVhost: string): string | null {
  if (row.name === DEFAULT_VHOST) {
    return "默认 vhost `/` 删不掉：连接串里省略 vhost 时落的就是它";
  }
  if (row.name === currentVhost) {
    // 不是服务端禁止，而是删完之后这条连接会落到一个不存在的 vhost 上，
    // 面板上所有页面一起失效，还找不到原因。
    return "这是当前连接正在使用的 vhost，删掉它会让这条连接上所有页面失效";
  }
  return null;
}

/** 删除用户该不该禁用，以及为什么。 */
export function userRemovalBlock(user: UserInfo, currentUser: string): string | null {
  if (user.name === currentUser) {
    return "这是当前连接正在使用的账号，删掉它等于把自己锁在门外";
  }
  return null;
}

/** 用户名里塞了空白字符时提示。AMQP URI 与命令行都会把它拼错。 */
export function badUserName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "用户名不能为空";
  if (/\s/.test(trimmed)) return "用户名里有空白字符，AMQP URI 与命令行容易拼错";
  return null;
}

/**
 * 口令强度提示。只挡最明显的两类，不做「必须含大小写」那套 ——
 * 那类规则只会把人逼去写 `Passw0rd!` 并贴在便签上。
 */
export function weakPassword(name: string, password: string): string | null {
  if (!password) return null;
  if (password === name.trim()) return "密码与用户名相同";
  if ([...password].length < 8) return "密码少于 8 位";
  return null;
}

/**
 * 新建用户时，标签选择区的提醒文案。
 *
 * 空标签是最容易踩的坑：用户建好了、密码也对，但连管理界面都进不去，
 * 而服务端不会有任何报错。
 */
export function tagSelectionHint(tags: string[]): string | null {
  if (tags.length === 0) {
    return "没选标签：这个账号能收发消息，但登不进管理界面，也看不到任何资源";
  }
  return null;
}

/** 队列数与权限数的摘要，表格里一行说清。 */
export function describeVhost(row: VhostRow): string {
  const parts = [`${row.queues} 个队列`, `${row.permissions} 条权限`];
  if (row.fullAccess > 0) parts.push(`${row.fullAccess} 条全开`);
  if (row.tracing) parts.push("跟踪用 vhost");
  return parts.join(" · ");
}
