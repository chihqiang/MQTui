/**
 * 渲染异常兜底。
 *
 * React 的默认行为是**整棵树**卸载：一个 `plan.impacts` 读空了，用户看到的是
 * 一整张白屏 —— 侧边栏、连接、正在跑的任务全部消失，连「刚才在哪一页」都找不回来。
 * 而真正出问题的往往只是详情页里那一张卡片。
 *
 * 所以这里放在内容区：某一页崩了，外壳（连接列表、菜单、健康条）继续在，
 * 用户可以切走、也可以原地重试。错误原文一律可选中复制 —— 排障时第一件事
 * 就是把这段贴给别人，而白屏什么也留不下。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryState {
  /** 捕获到的错误；`null` 表示正常渲染。 */
  error: Error | null;
  /** 最近一次捕获时的路由（`location.pathname`），用于「换一页自动恢复」。 */
  pathname: string;
}

/** 错误原文的展示形式：`Error` 取 message，其它按字符串处理。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  const text = String(error ?? "").trim();
  return text || "未知错误（没有 message）";
}

/**
 * 可选的堆栈。开发构建里默认展开，构建产物里收进 `<details>`：
 * 用户不需要读它，但需要能把它复制走。
 */
export function errorStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? "") : "";
}

/** 内容区兜底用的 props：边界本身只管「有没有崩」，路由由外层注入。 */
interface ErrorBoundaryProps {
  /** 当前路径；变化即视为换了页面，自动清掉上一次的错误。 */
  pathname?: string;
  children?: ReactNode;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, pathname: "" };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 开发期把组件栈打到控制台：这里不打，问题就只剩一句 message。
    console.error("渲染失败", error, info.componentStack);
  }

  /** 换页面就自动恢复：让用户不必为了「回上一页」再去点重试。 */
  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (state.error && props.pathname !== state.pathname) {
      return { error: null, pathname: props.pathname };
    }
    if (state.pathname !== props.pathname) {
      return { pathname: props.pathname };
    }
    return null;
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex flex-col gap-3 p-6">
        <div className="flex flex-col gap-2 rounded-lg border border-rose-200 bg-rose-50 p-4 text-rose-800">
          <p className="text-(length:--text-app-title) font-medium">这一页渲染失败了</p>
          <p className="selectable font-mono text-(length:--text-app-body) break-words">
            {errorText(error)}
          </p>
          {errorStack(error) ? (
            <details className="text-(length:--text-app-meta)">
              <summary className="cursor-pointer text-rose-700">堆栈</summary>
              <pre className="selectable mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-slate-600">
                {errorStack(error)}
              </pre>
            </details>
          ) : null}
          <p className="text-(length:--text-app-meta) text-slate-600">
            其余功能仍可用：左侧菜单换个页面就会自动恢复。
          </p>
        </div>
        <div>
          <button
            type="button"
            onClick={this.reset}
            className="rounded-lg bg-white px-3 py-1 text-(length:--text-app-body) font-medium text-slate-700 shadow-xs ring-1 ring-slate-200 transition-colors hover:bg-slate-50 hover:text-slate-900"
          >
            重试
          </button>
        </div>
      </div>
    );
  }
}

/** 内容区兜底用的 props：边界本身只管「有没有崩」，路由由外层注入。 */
interface ErrorBoundaryProps {
  /** 当前路径；变化即视为换了页面，自动清掉上一次的错误。 */
  pathname?: string;
  children?: ReactNode;
}
