import type { RefObject } from "react";

import type { DesktopAttachment } from "../../bridge";

function formatSize(size: number | null): string {
  if (size === null) return "大小未知";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function Composer({
  textareaRef,
  value,
  attachments,
  sending,
  disabled,
  status,
  hint,
  onChange,
  onSend,
  onPickAttachments,
  onRemoveAttachment,
  onOpenSettings,
}: {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  value: string;
  attachments: DesktopAttachment[];
  sending: boolean;
  disabled: boolean;
  status: string;
  hint: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onPickAttachments: () => void;
  onRemoveAttachment: (path: string) => void;
  onOpenSettings: () => void;
}) {
  const canSend = !disabled && !sending && (Boolean(value.trim()) || attachments.length > 0);
  return (
    <section className="composer composer-dock">
      <div className="composer-hint-row"><span className="composer-status">{status}</span><p className="muted">{hint}</p></div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="输入要继续推进的任务、问题或命令..."
        disabled={disabled || sending}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      {attachments.length > 0 ? <div className="composer-attachment-row">{attachments.map((attachment) => <div key={attachment.path} className="composer-attachment-chip"><div><strong>{attachment.name}</strong><p className="muted">{formatSize(attachment.size)}</p></div><button type="button" className="tool-btn" onClick={() => onRemoveAttachment(attachment.path)}>移除</button></div>)}</div> : null}
      <div className="composer-footer">
        <div className="composer-actions">
          <button className="composer-action" type="button" onClick={onPickAttachments} disabled={disabled || sending}>📎 附件{attachments.length > 0 ? ` (${attachments.length})` : ""}</button>
          <button className="composer-action" type="button" onClick={onOpenSettings}>⚙ 模型</button>
        </div>
        <button className="send-btn" type="button" onClick={onSend} disabled={!canSend}>{sending ? "..." : "发送 ↗"}</button>
      </div>
    </section>
  );
}
