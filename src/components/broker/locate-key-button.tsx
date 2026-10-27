import { Button } from "@/components/ui";
import { IconSearch } from "@/lib/icons";

/**
 * 「按这个 key 继续找」。
 *
 * 点完要做三件事：把 key 交给定位面板、切到定位模式、关掉详情弹窗。
 * 三件事都发生在外面，这个按钮只负责说清「我带过去的是哪个 key」——
 * 排查时人一次开着好几个详情，按钮上写清楚 key 比只写「找这个 key」有用。
 */
export function LocateKeyButton({
  messageKey,
  onLocateKey,
  onClose,
}: {
  messageKey: string;
  onLocateKey: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <Button
      size="xs"
      variant="ghost"
      icon={<IconSearch size={11} />}
      title={`把 key「${messageKey}」带进定位面板，顺序扫描这个 topic`}
      onClick={() => {
        onLocateKey(messageKey);
        onClose();
      }}
    >
      继续找
    </Button>
  );
}
