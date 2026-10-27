/**
 * 图标集。
 *
 * 只引 `react-icons` 里用得到的形状，统一走这个出口：
 * 1. 尺寸、线宽在一处定，界面上不会出现 15px 与 16px 混排；
 * 2. 图标永远配 `aria-hidden`，语义由按钮的 `aria-label` 或文字承担；
 * 3. 组件文件不直接 `import from "react-icons/*"` —— 换图标集时只改这里。
 *
 * 不自己写 SVG：图标是最典型的「能用成熟库就别造轮子」。需要新形状时先在
 * `react-icons/lu`（Lucide 线性图标）里找，找到就加一条导出，别手绘路径。
 */
import {
  LuArrowLeft,
  LuArrowRight,
  LuChevronDown,
  LuChevronRight,
  LuChartColumn,
  LuCirclePlay,
  LuCompass,
  LuActivity,
  LuCable,
  LuGitBranch,
  LuCopy,
  LuCornerUpLeft,
  LuInbox,
  LuLayers,
  LuMail,
  LuNetwork,
  LuSettings2,
  LuSlidersHorizontal,
  LuTable2,
  LuUsers,
  LuWaypoints,
  LuLoaderCircle,
  LuPanelLeftClose,
  LuPanelLeftOpen,
  LuPlug,
  LuPlus,
  LuRepeat,
  LuRefreshCw,
  LuSearch,
  LuSend,
  LuServer,
  LuSkull,
  LuTrash2,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";
import type { IconBaseProps, IconType } from "react-icons";

/** 统一尺寸：14px 配 12/13px 文字，16px 配 14px 文字。 */
const BASE: IconBaseProps = { size: 14, strokeWidth: 2, "aria-hidden": true };

const make = (Icon: IconType) => (props: IconBaseProps) => <Icon {...BASE} {...props} />;

export const IconAlert = make(LuTriangleAlert);
export const IconBack = make(LuArrowLeft);
export const IconForward = make(LuArrowRight);
export const IconChevronDown = make(LuChevronDown);
export const IconChevronRight = make(LuChevronRight);
export const IconClose = make(LuX);
export const IconCollapse = make(LuPanelLeftClose);
export const IconCopy = make(LuCopy);
export const IconDeadLetter = make(LuSkull);
export const IconExpand = make(LuPanelLeftOpen);
export const IconInbox = make(LuInbox);
export const IconPlug = make(LuPlug);
export const IconPlus = make(LuPlus);
export const IconRedeliver = make(LuCornerUpLeft);
export const IconRefresh = make(LuRefreshCw);
export const IconResend = make(LuSend);
export const IconRepeat = make(LuRepeat);
export const IconSearch = make(LuSearch);
export const IconServer = make(LuServer);

/* 菜单图标。能力 → 形状在 `lib/nav.ts` 的 `NAV_LABELS` 里登记，
   这里只负责「有这些形状可用」。 */
export const IconOverview = make(LuCompass);
export const IconCluster = make(LuNetwork);
export const IconRuntime = make(LuCable);
export const IconTopics = make(LuLayers);
export const IconQueues = make(LuTable2);
export const IconMessages = make(LuMail);
export const IconProduce = make(LuCirclePlay);
export const IconGroups = make(LuUsers);
export const IconExchanges = make(LuGitBranch);
export const IconRouting = make(LuWaypoints);
export const IconTopology = make(LuActivity);
export const IconGraph = make(LuChartColumn);
export const IconConfig = make(LuSettings2);
export const IconSliders = make(LuSlidersHorizontal);
export const IconTrash = make(LuTrash2);

/** 加载指示器：和 `animate-spin` 一起用。 */
export const IconSpinner = make(LuLoaderCircle);
