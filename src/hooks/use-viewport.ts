import { useSyncExternalStore } from "react";

/**
 * 视口宽度。
 *
 * 只暴露宽度而不是「是不是窄屏」：阈值判断在 `lib/layout.ts` 里做成纯函数，
 * 组件里就没有第二个地方解释「多窄算窄」。
 *
 * `resize` 事件本身是高频的，但这里**不做节流** —— 订阅者只有一个外壳，
 * 它读到的宽度只在跨过阈值时才改变渲染结果（`resolveLayout` 是纯函数，
 * 中间那些像素变化算出来的还是同一个字符串）。给一个纯函数加节流，
 * 换来的只是「拉宽窗口后侧边栏慢半拍才回来」。
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function getSnapshot(): number {
  return window.innerWidth;
}

export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
