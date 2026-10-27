/**
 * 表单公共的提交区：保存开关。
 *
 * 新建连接与编辑连接两套表单都要这一段，而两处的措辞必须一致 ——
 * 「不勾选能不能连」「口令会不会留下」是同一件事，说法不同就会让人以为
 * 两个入口的行为不一样。
 */
/** 表单公共的提交区：保存开关。提交按钮在弹窗页脚上。 */
export function SubmitRow({
  save,
  onSaveChange,
}: {
  save: boolean;
  onSaveChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 border-t border-slate-100 pt-3 text-(length:--text-app-meta) text-slate-500">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={save}
        onChange={(event) => onSaveChange(event.currentTarget.checked)}
      />
      <span>
        保存此连接（连同密码写入本机 localStorage）
        <br />
        {/*
          这里原来写的是「不勾选则仅在本次运行期间有效」—— 那句话还带着旧语义：
          早期确实只有保存过的连接才会出现在首页，没勾的人连成功也什么都不剩。
          现在连成功会留下一条「连过」的历史（只有名字与地址），文案必须跟着改，
          否则用户会以为不勾就等于白连一次。
        */}
        <span className="text-meta">
          不勾选也能连，只是不留口令：下次在首页那一行点「补口令」重填即可
        </span>
      </span>
    </label>
  );
}
