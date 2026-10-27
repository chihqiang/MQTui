import { Link } from "react-router";

import { Empty } from "@/components/ui";

export function NotFoundPage() {
  return (
    <Empty
      title="页面不存在"
      description="请检查地址，或返回首页重新选择连接"
      action={
        <Link to="/" className="text-xs text-info hover:underline">
          返回首页
        </Link>
      }
    />
  );
}
