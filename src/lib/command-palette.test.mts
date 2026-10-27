/**
 * 命令面板纯逻辑的校验脚本。
 *
 * 前端没有引入测试框架（不为几行断言加 vitest + DOM 环境），
 * 这里用 node 内置的 `node:test` 直接跑纯函数，`npm run test:web` 即可。
 *
 * 仓库没有引入 `@types/node`（构建前端用不上），所以对这两个模块加了
 * `@ts-expect-error`：不给生产依赖加包袱，类型检查也照样能过。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  clampSelection,
  type Command,
  isPaletteShortcut,
  isSettingsShortcut,
  isTypingTarget,
  moveSelection,
  rankCommands,
  SCORE_CONTAINS,
  SCORE_KEYWORD,
  SCORE_PREFIX,
  SCORE_SUMMARY,
  scoreCommand,
  summarize,
} from "./command-palette.ts";
import { orderByRecent, pushRecent } from "./command-history.ts";

const noop = () => {};
const command = (id: string, title: string, keywords: string[] = []): Command => ({
  id,
  title,
  group: "测试",
  keywords,
  run: noop,
});

test("空查询返回全部命令，保持原顺序", () => {
  const list = [command("a", "概览"), command("b", "队列")];
  const ranked = rankCommands(list, "   ");
  assert.deepEqual(
    ranked.map((item) => item.command.id),
    ["a", "b"],
  );
  assert.ok(ranked.every((item) => item.score === SCORE_SUMMARY));
});

test("精确、前缀、子串、关键字依次降档", () => {
  const exact = command("1", "队列");
  const prefix = command("2", "队列详情");
  const contains = command("3", "全部队列");
  const keyword = command("4", "堆积", ["queues"]);

  assert.equal(scoreCommand(exact, "队列"), 100);
  assert.equal(scoreCommand(prefix, "队列"), SCORE_PREFIX);
  assert.equal(scoreCommand(contains, "队列"), SCORE_CONTAINS);
  assert.equal(scoreCommand(keyword, "queue"), SCORE_KEYWORD);
  assert.equal(scoreCommand(exact, "消费组"), 0);
});

test("匹配不区分大小写，且忽略首尾空白", () => {
  assert.equal(scoreCommand(command("1", "RabbitMQ"), "  rabbitmq "), 100);
  assert.ok(scoreCommand(command("1", "消费者"), "XIAOFEI") === 0);
});

test("排序按分数倒序，同分保持原顺序", () => {
  const list = [command("1", "消息"), command("2", "消息定位"), command("3", "消息"), command("4", "队列")];
  const ranked = rankCommands(list, "消息");
  assert.deepEqual(
    ranked.map((item) => item.command.id),
    ["1", "3", "2"],
  );
});

test("全量不匹配时返回空数组", () => {
  assert.deepEqual(rankCommands([command("1", "概览")], "zzz"), []);
});

test("上下键回绕，空列表返回 -1", () => {
  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, 1, 3), 0);
  assert.equal(moveSelection(0, -1, 3), 2);
  assert.equal(moveSelection(-1, 1, 3), 0);
  assert.equal(moveSelection(-1, -1, 3), 2);
  assert.equal(moveSelection(0, 1, 0), -1);
});

test("选中项收敛在结果范围内", () => {
  assert.equal(clampSelection(5, 3), 2);
  assert.equal(clampSelection(-2, 3), 0);
  assert.equal(clampSelection(1, 0), -1);
});

test("摘要折叠空白并截断，截断时带省略号", () => {
  assert.equal(summarize("  集群\n  信息  "), "集群 信息");
  const long = summarize("消".repeat(80), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith("…"));
});

test("mac 用 ⌘K，其余平台用 Ctrl+K", () => {
  const base = { key: "k", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(isPaletteShortcut({ ...base, metaKey: true }, true), true);
  assert.equal(isPaletteShortcut({ ...base, ctrlKey: true }, true), false);
  assert.equal(isPaletteShortcut({ ...base, ctrlKey: true }, false), true);
  assert.equal(isPaletteShortcut({ ...base, metaKey: true }, false), false);
  assert.equal(isPaletteShortcut({ ...base, ctrlKey: true, shiftKey: true }, false), false);
  assert.equal(isPaletteShortcut({ ...base, key: "j", ctrlKey: true }, false), false);
});

test("在输入框里打字不算快捷键场景", () => {
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" } as unknown as EventTarget), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: false } as unknown as EventTarget), false);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget), true);
});

test("最近使用只调整顺序，不改变匹配结果", () => {
  const list = [command("a", "概览"), command("b", "队列"), command("c", "消息")];
  const ordered = orderByRecent(list, ["c", "a"]);
  assert.deepEqual(
    ordered.map((item) => item.id),
    ["c", "a", "b"],
  );
  // 没有历史记录时原样返回：不给「一次都没用过」的场景添乱。
  assert.deepEqual(orderByRecent(list, []), list);
});

test("历史记录里的失效 id 不参与排序", () => {
  const list = [command("a", "概览"), command("b", "队列")];
  const ordered = orderByRecent(list, ["gone", "b"]);
  assert.deepEqual(
    ordered.map((item) => item.id),
    ["b", "a"],
  );
});

test("最近使用去重并裁到上限", () => {
  assert.deepEqual(pushRecent(["a", "b"], "b"), ["b", "a"]);
  assert.deepEqual(pushRecent(["a", "b", "c", "d", "e"], "f"), ["f", "a", "b", "c", "d"]);
  assert.equal(pushRecent([], "a").length, 1);
});

test("设置快捷键：mac 用 ⌘,，其他平台 Ctrl+,", () => {
  const key = { key: ",", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(isSettingsShortcut({ ...key, metaKey: true }, true), true);
  assert.equal(isSettingsShortcut({ ...key, ctrlKey: true }, false), true);
  // 不带修饰键的逗号是打字，不是命令。
  assert.equal(isSettingsShortcut(key, true), false);
  // 换个键就不是设置。
  assert.equal(isSettingsShortcut({ ...key, key: ".", metaKey: true }, true), false);
  // 带 Alt/Shift 的组合留给别的功能。
  assert.equal(isSettingsShortcut({ ...key, metaKey: true, shiftKey: true }, true), false);
});
