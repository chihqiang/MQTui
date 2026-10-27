/**
 * 通用的键盘事件判定。
 *
 * 向导（数字键选类型、回车进表单）发全局 keydown，但它不能和「正在输入」抢键 ——
 * 用户在地址字段里打 `1`、在过滤框里按回车，都不该被当成在操作浮层。
 */

/**
 * 是否是「正在输入文字」。面板靠全局 keydown 触发，但用户在输入框里打 k、
 * 或在中转站里按 Ctrl+K（浏览器习惯）时不该弹出来。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return element.isContentEditable;
}
