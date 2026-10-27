/**
 * 参数页面纯逻辑校验：组件切换、vhost 语义、分组与过滤。
 *
 * 这些规则错了不会报错，只会让「配置看起来保存了、其实不生效」，
 * 所以每条都要有用例盯着。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  compactValue,
  componentLabel,
  dialsOut,
  filterParameters,
  groupByComponent,
  isKnownComponent,
  requiresDefaultVhost,
  templateFor,
  vhostAfterSwitch,
} from "./parameter.ts";

function parameter(component: string, vhost: string, name: string, value: unknown = {}) {
  return { component, vhost, name, value };
}

test("component names map to chinese labels and unknown ones pass through", () => {
  assert.equal(componentLabel("federation-upstream"), "联邦上游");
  assert.equal(componentLabel("shovel"), "铲子");
  // 插件注册的组件不丢，也不被标成错误。
  assert.equal(componentLabel("x-custom"), "x-custom");
  assert.ok(isKnownComponent("runtime"));
  assert.ok(!isKnownComponent("x-custom"));
});

test("runtime is the only node-scoped component", () => {
  assert.ok(requiresDefaultVhost("runtime"));
  assert.ok(!requiresDefaultVhost("shovel"));
  assert.ok(!requiresDefaultVhost("federation-upstream"));
});

test("switching to runtime pins vhost back to default", () => {
  assert.equal(vhostAfterSwitch("runtime", "orders"), "/");
  // 切走之后把 `/` 清空，交给用户填业务 vhost。
  assert.equal(vhostAfterSwitch("shovel", "/"), "");
  assert.equal(vhostAfterSwitch("shovel", "orders"), "orders");
});

test("templates are valid json and carry the required keys", () => {
  const upstream = JSON.parse(templateFor("federation-upstream"));
  assert.ok(typeof upstream.uri === "string");

  const shovel = JSON.parse(templateFor("shovel"));
  assert.ok(typeof shovel["src-uri"] === "string");
  assert.ok(typeof shovel["dest-uri"] === "string");

  const set = JSON.parse(templateFor("federation-upstream-set"));
  assert.ok(Array.isArray(set.value));

  // runtime 的值本身就是字符串，模板要给带引号的 JSON 文本，才满足「值是合法 JSON」。
  assert.equal(JSON.parse(templateFor("runtime")), "cluster-name");
});

test("only federation and shovel dial out", () => {
  assert.ok(dialsOut("federation-upstream"));
  assert.ok(dialsOut("federation-upstream-set"));
  assert.ok(dialsOut("shovel"));
  assert.ok(!dialsOut("runtime"));
});

test("grouping keeps known components in declared order", () => {
  const groups = groupByComponent([
    parameter("runtime", "/", "cluster_name", "prod"),
    parameter("shovel", "/", "sh1"),
    parameter("federation-upstream", "orders", "up1"),
    parameter("x-custom", "/", "weird"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.component),
    ["federation-upstream", "shovel", "runtime", "x-custom"],
  );
});

test("filter searches name, vhost and value text", () => {
  const items = [
    parameter("federation-upstream", "orders", "up-prod", { uri: "amqp://remote:5672" }),
    parameter("runtime", "/", "cluster_name", "staging-cluster"),
  ];
  assert.equal(filterParameters(items, "").length, 2);
  assert.equal(filterParameters(items, "prod")[0].name, "up-prod");
  assert.equal(filterParameters(items, "staging")[0].name, "cluster_name");
  assert.equal(filterParameters(items, "orders")[0].name, "up-prod");
  assert.equal(filterParameters(items, "nothing").length, 0);
});

test("compact value collapses whitespace and truncates", () => {
  assert.equal(compactValue('{\n  "a": 1\n}'), '{ "a": 1 }');
  assert.equal(compactValue("x".repeat(200), 10).length, 11);
});
