/**
 * 失败提示的措辞。
 *
 * 「读取失败」这四个字是面板里最常见、也最没用的一句话：用户知道失败了，
 * 想知道的是「哪儿失败了」。队列页的请求和启动自检的请求都返回一句
 * 「连接被拒绝」，人完全判断不出该动配置还是该等网络。
 *
 * 所以错误提示统一带上「动作 + 对象」。这里只管措辞，不碰 React。
 */

/**
 * 拼一句带上下文的错误文案。
 *
 * `action` 用动宾短语（「读取队列」「删除主题」），`subject` 放具体对象名。
 * 一旦对象名已经在标题里显示过（弹窗标题就是队列名），`subject` 传空即可，
 * 不必重复。
 */
export function failureText(action: string, error: string, subject?: string): string {
  const target = subject?.trim();
  return target ? `${action} ${target} 失败：${error}` : `${action}失败：${error}`;
}

/**
 * 请求失败后，旧数据还能不能继续看。
 *
 * 刷新失败时把整页换成错误页，等于「一次网络抖动把已经在手上的信息全收走了」。
 * 有旧数据就留着，并在顶部挂一条提示；没有旧数据才让错误页占据内容区。
 */
export function shouldReplaceWithError({
  hasData,
  isFetching,
}: {
  hasData: boolean;
  isFetching: boolean;
}): boolean {
  if (hasData) return false;
  // 正在重试时不留错误页：错误页闪一下再被骨架替换，比一直显示错误更晃眼。
  return !isFetching;
}
