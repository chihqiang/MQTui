/**
 * 参数页面纯逻辑校验：组件切换、vhost 语义、分组与过滤。
 *
 * 这些规则错了不会报错，只会让「配置看起来保存了、其实不生效」，
 * 所以每条都要有用例盯着。
 */

import { expect, test } from "vitest";

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
  expect(componentLabel("federation-upstream")).toBe("联邦上游");
  expect(componentLabel("shovel")).toBe("铲子");
  // 插件注册的组件不丢，也不被标成错误。
  expect(componentLabel("x-custom")).toBe("x-custom");
  expect(isKnownComponent("runtime")).toBeTruthy();
  expect(isKnownComponent("x-custom")).toBe(false);
});

test("runtime is the only node-scoped component", () => {
  expect(requiresDefaultVhost("runtime")).toBeTruthy();
  expect(requiresDefaultVhost("shovel")).toBe(false);
  expect(requiresDefaultVhost("federation-upstream")).toBe(false);
});

test("switching to runtime pins vhost back to default", () => {
  expect(vhostAfterSwitch("runtime", "orders")).toBe("/");
  // 切走之后把 `/` 清空，交给用户填业务 vhost。
  expect(vhostAfterSwitch("shovel", "/")).toBe("");
  expect(vhostAfterSwitch("shovel", "orders")).toBe("orders");
});

test("templates are valid json and carry the required keys", () => {
  const upstream = JSON.parse(templateFor("federation-upstream"));
  expect(typeof upstream.uri === "string").toBeTruthy();

  const shovel = JSON.parse(templateFor("shovel"));
  expect(typeof shovel["src-uri"] === "string").toBeTruthy();
  expect(typeof shovel["dest-uri"] === "string").toBeTruthy();

  const set = JSON.parse(templateFor("federation-upstream-set"));
  expect(Array.isArray(set.value)).toBeTruthy();

  // runtime 的值本身就是字符串，模板要给带引号的 JSON 文本，才满足「值是合法 JSON」。
  expect(JSON.parse(templateFor("runtime"))).toBe("cluster-name");
});

test("only federation and shovel dial out", () => {
  expect(dialsOut("federation-upstream")).toBeTruthy();
  expect(dialsOut("federation-upstream-set")).toBeTruthy();
  expect(dialsOut("shovel")).toBeTruthy();
  expect(dialsOut("runtime")).toBe(false);
});

test("grouping keeps known components in declared order", () => {
  const groups = groupByComponent([
    parameter("runtime", "/", "cluster_name", "prod"),
    parameter("shovel", "/", "sh1"),
    parameter("federation-upstream", "orders", "up1"),
    parameter("x-custom", "/", "weird"),
  ]);
  expect(groups.map((group) => group.component)).toEqual(["federation-upstream", "shovel", "runtime", "x-custom"]);
});

test("filter searches name, vhost and value text", () => {
  const items = [
    parameter("federation-upstream", "orders", "up-prod", { uri: "amqp://remote:5672" }),
    parameter("runtime", "/", "cluster_name", "staging-cluster"),
  ];
  expect(filterParameters(items, "").length).toBe(2);
  expect(filterParameters(items, "prod")[0].name).toBe("up-prod");
  expect(filterParameters(items, "staging")[0].name).toBe("cluster_name");
  expect(filterParameters(items, "orders")[0].name).toBe("up-prod");
  expect(filterParameters(items, "nothing").length).toBe(0);
});

test("compact value collapses whitespace and truncates", () => {
  expect(compactValue('{\n  "a": 1\n}')).toBe('{ "a": 1 }');
  expect(compactValue("x".repeat(200), 10).length).toBe(11);
});
