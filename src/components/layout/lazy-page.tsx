/**
 * 页面文件用命名导出，而 `lazy` 只认 `default` —— 这里转一层，
 * 页面本身不用改写法。放在 lib：它不认识任何一页，只是一个泛型工具。
 */

import { lazy, type ComponentType } from "react";

export function lazyNamed<T extends Record<string, unknown>>(
  load: () => Promise<T>,
  name: keyof T & string,
): ComponentType {
  return lazy(async () => {
    const module = await load();
    return { default: module[name] as ComponentType };
  });
}
