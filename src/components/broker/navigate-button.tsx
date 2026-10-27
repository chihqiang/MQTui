import { useNavigate } from "react-router";

import { Button, type ButtonProps } from "@/components/ui";

/**
 * 「查看消息」这类跳转按钮。
 *
 * 全站有七八处同名按钮，各自手写 `navigate(path)`：路径拼错时页面照样打开，
 * 只是目标空了 —— 不报错，只是默默不对。所以跳哪儿由调用方给一条算好的路径，
 * 这里只负责导航与阻止冒泡（这类按钮多数长在「点整行就展开」的表格行里）。
 */
export function NavigateButton({
  to,
  children,
  onClick,
  size = "sm",
  variant = "secondary",
  ...props
}: { to: string } & Omit<ButtonProps, "onClick"> & { onClick?: () => void }) {
  const navigate = useNavigate();
  return (
    <Button
      size={size}
      variant={variant}
      {...props}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </Button>
  );
}
