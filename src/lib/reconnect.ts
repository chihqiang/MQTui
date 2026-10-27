/**
 * 「从连接记录里再连一次」的共用措辞。
 *
 * 首页那张记录列表和命令面板里的「重连」是同一件事，但两边各自写过一遍
 * 「第几条正在连」的簿记 —— 于是同一条记录在首页转圈、在命令面板里却是灰的，
 * 点了还会重复发起请求。
 *
 * 这里只做纯的事：判断哪一条正在连、按钮写什么字。状态本身仍然放在调用方，
 * 因为这个模块不碰 React。
 *
 * 「能不能重连」的判据不在这里 —— 它长在历史条目上（`canReconnect`，
 * 见 `lib/connection-history.ts`），因为同一条判据要同时服务首页那张表和命令面板。
 * 这个模块只负责措辞。
 */

/** 表单一侧的忙碌状态与记录一侧的忙碌状态经常同时存在，合并成一个判据。 */
export function isEntryBusy(entryId: string, busyId: string | null): boolean {
  return entryId === busyId;
}

/**
 * 忙碌时的按钮文案。
 *
 * 不写「加载中」：面板里同时可能有三处在转圈，`正在连接 kafka-prod`
 * 才回答「哪一条在等」。
 */
export function reconnectLabel(name: string, busy: boolean): string {
  return busy ? `正在连接 ${name}` : "重连";
}

/**
 * 断开按钮的文案。
 *
 * 和重连同一个道理：列表里可能同时挂着几条连接，常亮的叉号回答不了
 * 「断的是哪一条」。悬停时把它说出来，点之前就确定。
 */
export function disconnectLabel(name: string, busy: boolean): string {
  return busy ? `正在断开 ${name}` : `断开 ${name}`;
}
