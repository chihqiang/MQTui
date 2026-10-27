/** RabbitMQ 参数接口，对应 `src-tauri/src/commands/parameter.rs`。 */

import { call } from "./ipc";
import type {
  ParameterComponent,
  ParameterReview,
  ParameterSnapshot,
  ParameterSpec,
} from "@/types/parameter";

export const parameterService = {
  /** 全部参数（按组件分类拉取，某一类失败只影响它自己）。 */
  listParameters: (id: string) => call<ParameterSnapshot>("list_parameters", { id }),

  /** 本地校验：JSON 语法、组件形状、vhost 语义与后果提醒。不写任何东西。 */
  reviewParameter: (spec: ParameterSpec) =>
    call<ParameterReview>("review_parameter_spec", { spec }),

  /** 保存参数。`originalName` 非空表示重命名（先建新的、再删旧的）。 */
  saveParameter: (id: string, spec: ParameterSpec, originalName?: string) =>
    call<ParameterSnapshot>("save_parameter", { id, spec, originalName: originalName ?? null }),

  deleteParameter: (id: string, component: ParameterComponent, vhost: string, name: string) =>
    call<ParameterSnapshot>("delete_parameter", { id, component, vhost, name }),
};
