export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("当前环境不支持剪贴板写入。");
  }
  await navigator.clipboard.writeText(text);
}
