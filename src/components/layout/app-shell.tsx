import { Outlet, useParams } from "react-router";

import { ToastViewport } from "@/components/ui";

import { ConnectionSidebar } from "./connection-sidebar";
import { HealthBar } from "./health-bar";
import { NavSidebar } from "./nav-sidebar";

/**
 * 应用外壳：左右结构。
 *
 * ┌──────────┬──────────────┬──────────────────┐
 * │ 连接列表 │ 能力菜单     │ 内容区           │
 * └──────────┴──────────────┴──────────────────┘
 *
 * 连接列表常驻，菜单随当前连接的能力动态变化。
 * 内容区顶部固定一条健康状态，健康问题一次暴露，不必每页重新发现。
 */
export function AppShell() {
  const { connectionId } = useParams();

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100">
      <ConnectionSidebar />
      <NavSidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 未选中连接时（连接页）没有可探测的对象，不显示健康条。 */}
        {connectionId ? <HealthBar connectionId={connectionId} /> : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>
      <ToastViewport />
    </div>
  );
}
