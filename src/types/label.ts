/** 界面文案项的通用形状。`hint` 是悬停/说明用的第二句，没有就不写。 */

export interface LabelOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}
