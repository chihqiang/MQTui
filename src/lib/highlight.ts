/**
 * 把命中的片段切出来，交给调用方分别上色。
 *
 * 搜索框里打了字，结果列表却只换了个底色 —— 用户还得自己在一行字里
 * 找那个词落在哪。切分成三段（前 / 命中 / 后）是最小的能让「为什么这条
 * 会出现在结果里」这问题一眼有答案的做法。
 *
 * 只取第一处命中：命令面板的一行本来就短，多处高亮只会变成一片色块。
 * `needle` 为空时原样返回，调用方不必自己判断。
 */
export interface HighlightParts {
  head: string;
  hit: string;
  tail: string;
}

export function splitHighlight(text: string, needle: string): HighlightParts {
  const query = needle.trim().toLowerCase();
  if (!query) return { head: text, hit: "", tail: "" };
  // 命中的位置按小写后的下标取回原文，保留用户输入的大小写。
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return { head: text, hit: "", tail: "" };
  return {
    head: text.slice(0, at),
    hit: text.slice(at, at + query.length),
    tail: text.slice(at + query.length),
  };
}
