/**
 * 与 `src-tauri/src/domain/parameter.rs` 一一对应的领域类型。
 * 修改 Rust 侧结构时请同步更新此文件。
 */

/**
 * 参数组件。
 *
 * 注意这里的取值是**组件在管理 API 里的名字**（带连字符），
 * 不是驼峰——路径里直接用它拼。
 */
export type ParameterComponent =
  | "federation-upstream"
  | "federation-upstream-set"
  | "shovel"
  | "runtime";

export interface ParameterInfo {
  component: string;
  vhost: string;
  name: string;
  /** 原始 JSON。不同组件结构完全不同，前端不建模，直接展示 / 编辑。 */
  value: unknown;
}

export interface ParameterError {
  component: string;
  message: string;
}

export interface ParameterSnapshot {
  parameters: ParameterInfo[];
  /** 按组件记录的拉取失败原因（权限不足 / 插件未启用）。 */
  errors: ParameterError[];
  /** 管理 API 是否支持 `{component}` 过滤。老版本不支持时应提示，而不是展示一堆红字。 */
  componentFilterSupported: boolean;
}

export interface ParameterSpec {
  component: ParameterComponent;
  vhost: string;
  name: string;
  /** 提交的原始 JSON 文本：语法错时要把用户输入原样还回去。 */
  value: string;
}

/** 校验结果：`errors` 非空即阻断；`caveats` 只提醒。 */
export interface ParameterReview {
  errors: string[];
  caveats: string[];
}

export interface ParameterRemoval {
  allowed: boolean;
  detail: string;
}
