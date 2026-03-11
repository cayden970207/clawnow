import { describe, expect, it, vi } from "vitest";
import { handleDisconnected } from "./app-lifecycle.ts";

function createHost() {
  return {
    basePath: "",
    client: { stop: vi.fn() },
    connected: true,
    tab: "chat",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: null,
    tasksPollInterval: null,
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    visibilityChangeHandler: vi.fn(),
    popStateHandler: vi.fn(),
    topbarObserver: { disconnect: vi.fn() } as unknown as ResizeObserver,
  };
}

describe("handleDisconnected", () => {
  it("stops and clears gateway client on teardown", () => {
    const windowRemoveSpy = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation(() => undefined);
    const documentRemoveSpy = vi
      .spyOn(document, "removeEventListener")
      .mockImplementation(() => undefined);
    const host = createHost();
    const disconnectSpy = (
      host.topbarObserver as unknown as { disconnect: ReturnType<typeof vi.fn> }
    ).disconnect;

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(windowRemoveSpy).toHaveBeenCalledWith("popstate", host.popStateHandler);
    expect(documentRemoveSpy).toHaveBeenCalledWith(
      "visibilitychange",
      host.visibilityChangeHandler,
    );
    expect(host.client).toBeNull();
    expect(host.connected).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(host.topbarObserver).toBeNull();
    windowRemoveSpy.mockRestore();
    documentRemoveSpy.mockRestore();
  });
});
