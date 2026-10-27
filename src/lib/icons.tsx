/**
 * 图标集。
 *
 * 只引 `lucide-react` 里用得到的形状，统一走这个出口：
 * 1. 尺寸、线宽在一处定，界面上不会出现 15px 与 16px 混排；
 * 2. 图标永远配 `aria-hidden`，语义由按钮的 `aria-label` 或文字承担。
 *
 * 不自己写 SVG：图标是最典型的「能用成熟库就别造轮子」。
 */
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerUpLeft,
  Inbox,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Skull,
  X,
} from "lucide-react";
import type { LucideProps } from "lucide-react";

/** 统一尺寸：14px 配 12/13px 文字，16px 配 14px 文字。 */
const BASE: LucideProps = { size: 14, strokeWidth: 2, "aria-hidden": true };

const make = (Icon: typeof X) => (props: LucideProps) => <Icon {...BASE} {...props} />;

export const IconAlert = make(AlertTriangle);
export const IconBack = make(ArrowLeft);
export const IconChevronDown = make(ChevronDown);
export const IconChevronRight = make(ChevronRight);
export const IconClose = make(X);
export const IconCollapse = make(PanelLeftClose);
export const IconCopy = make(Copy);
export const IconDeadLetter = make(Skull);
export const IconExpand = make(PanelLeftOpen);
export const IconInbox = make(Inbox);
export const IconPlus = make(Plus);
export const IconRedeliver = make(CornerUpLeft);
export const IconRefresh = make(RefreshCw);
export const IconResend = make(Send);
export const IconSearch = make(Search);
export const IconSettings = make(Settings);

/** 加载指示器：和 `animate-spin` 一起用。 */
export const IconSpinner = make(Loader2);
