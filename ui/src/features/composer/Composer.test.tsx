import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

const baseProps = {
  value: "",
  attachments: [],
  sending: false,
  disabled: false,
  status: "就绪",
  hint: "Enter 发送",
  onChange: () => {},
  onSend: () => {},
  onPickAttachments: () => {},
  onRemoveAttachment: () => {},
  onOpenSettings: () => {},
};

describe("Composer", () => {
  it("sends on Enter but not Shift+Enter", () => {
    const send = vi.fn();
    render(<Composer {...baseProps} value="继续" onSend={send} />);
    const textbox = screen.getByRole("textbox");
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("allows attachment-only send and removal", async () => {
    const send = vi.fn();
    const remove = vi.fn();
    const user = userEvent.setup();
    render(<Composer {...baseProps} attachments={[{ name: "a.txt", path: "G:\\a.txt", uri: "file:///G:/a.txt", size: 20 }]} onSend={send} onRemoveAttachment={remove} />);
    await user.click(screen.getByRole("button", { name: "发送 ↗" }));
    await user.click(screen.getByRole("button", { name: "移除" }));
    expect(send).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("G:\\a.txt");
  });
});
