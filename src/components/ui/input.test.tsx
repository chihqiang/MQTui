/**
 * 输入控件的默认属性。
 *
 * 钉的是「macOS 会把首字母自动大写」这一类静默改值：组件在这里少写一个属性，
 * 界面上看不出来，只有在真机上敲 `ceshi` 变成 `Ceshi` 之后去查队列才会撞上。
 * 逐个基础控件断言，是因为它们各自画了一个 `<input>` / `<textarea>`，
 * 只在 `Input` 上加过属性、漏掉 `SearchInput` 的内层输入框，一样会中招。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { ComboInput, Input, SearchInput, Textarea } from "@/components/ui";

/** HTML 属性名大小写不敏感，SSR 会原样输出 camelCase，比较前统一转小写。 */
function attrsOf(element: React.ReactElement): string {
  return renderToStaticMarkup(element).toLowerCase();
}

function expectNoTextAssist(html: string) {
  expect(html).toContain('autocapitalize="off"');
  expect(html).toContain('autocorrect="off"');
  expect(html).toContain('spellcheck="false"');
}

test("输入框关闭首字母大写与拼写纠正", () => {
  expectNoTextAssist(attrsOf(<Input value="" onChange={() => {}} />));
});

test("多行文本关闭首字母大写与拼写纠正", () => {
  // 消息正文、迁移清单这类多行输入被改写，等于发出去的内容和看到的不是同一份。
  expectNoTextAssist(attrsOf(<Textarea value="" onChange={() => {}} />));
});

test("过滤框与候选下拉同样关闭", () => {
  expectNoTextAssist(attrsOf(<SearchInput value="" onValueChange={() => {}} />));
  expectNoTextAssist(
    attrsOf(<ComboInput value="" onValueChange={() => {}} choices={[]} placeholder="队列名" />),
  );
});

test("调用方可以显式覆盖", () => {
  // 默认值只是默认值：真需要按句首大写的自由文本，不该被组件写死。
  const html = attrsOf(<Input value="" onChange={() => {}} autoCapitalize="sentences" />);
  expect(html).toContain('autocapitalize="sentences"');
});
