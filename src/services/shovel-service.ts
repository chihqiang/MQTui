/** RabbitMQ 铲子运行态接口，对应 `src-tauri/src/commands/shovel.rs`。 */

import { call } from "./ipc";
import type { ShovelSnapshot } from "@/types/shovel";

export const shovelService = {
  /** 铲子快照：配置（参数接口）与运行态（`/api/shovels`）配对。 */
  listShovels: (id: string) => call<ShovelSnapshot>("list_shovels", { id }),
};
