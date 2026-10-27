/**
 * 跨页动作的单测。
 *
 * 这一组钉的是「默默不对」的那类错：路径少一层编码、确认文案把「不知道」说成「0 条」。
 * 它们都不会抛异常，只会在用户那里表现成「页面打开了但目标空了」。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { describeAction, locatePath, messagesPath, singleTargetHint } from "./actions.ts";

test("没有目标时不带 query", () => {
  assert.equal(messagesPath("c1"), "/connections/c1/messages");
  assert.equal(messagesPath("c1", "  "), "/connections/c1/messages");
});

test("目标名里的斜杠与空格必须被编码", () => {
  assert.equal(
    messagesPath("c1", "order/created 1"),
    "/connections/c1/messages?target=order%2Fcreated%201",
  );
});

test("定位入口带上 key 与分区", () => {
  const path = locatePath("c1", { target: "orders", key: "k-1", partition: 3 });
  assert.match(path, /target=orders/);
  assert.match(path, /key=k-1/);
  assert.match(path, /partition=3/);
  assert.match(path, /locate=1/);
});

test("分区号 0 也要带上", () => {
  assert.match(locatePath("c1", { target: "t", partition: 0 }), /partition=0/);
});

test("条数没上报时不说成 0 条", () => {
  const impact = describeAction({ target: "q1", messages: undefined, losesMessages: true });
  assert.match(impact.summary, /全部消息/);
  assert.ok(!impact.summary.includes("0 条"));
});

test("空队列的措辞与有积压的措辞不同", () => {
  const empty = describeAction({ target: "q1", messages: 0, losesMessages: true });
  const full = describeAction({ target: "q1", messages: 300, losesMessages: true });
  assert.notEqual(empty.summary, full.summary);
  assert.match(full.summary, /300 条/);
});

test("有消费者时写清会断流", () => {
  const impact = describeAction({ target: "q1", messages: 5, consumers: 2, losesMessages: true });
  assert.match(impact.summary, /2 个消费者/);
});

test("多选时看消息要给原因而不是静默置灰", () => {
  assert.equal(singleTargetHint(1), undefined);
  assert.match(singleTargetHint(3) ?? "", /一次只读一个目标/);
});
