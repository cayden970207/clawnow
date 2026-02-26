import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway config.set trusted-proxy preservation", () => {
  it("keeps trusted-proxy control UI defaults when raw config omits gateway", async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set in gateway test environment");
    }

    const initialConfig = {
      gateway: {
        mode: "local",
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: [
              "x-clawnow-verified",
              "x-clawnow-instance-id",
              "x-clawnow-session-type",
            ],
          },
        },
        trustedProxies: ["127.0.0.1", "::1"],
        controlUi: {
          basePath: "/clawnow",
          root: "/opt/clawnow/control-ui/current",
          allowedOrigins: ["http://127.0.0.1:18790"],
          dangerouslyAllowHostHeaderOriginFallback: true,
          dangerouslyDisableDeviceAuth: true,
        },
      },
    };

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

    // Use file-backed trusted-proxy auth for this test (no test override).
    testState.gatewayAuth = undefined;
    testState.gatewayControlUi = undefined;

    const started = await startServerWithClient(undefined, {
      controlUiEnabled: true,
      wsHeaders: {
        origin: "http://127.0.0.1:18790",
        "x-forwarded-user": "tenant-user",
        "x-clawnow-verified": "1",
        "x-clawnow-instance-id": "inst-123",
        "x-clawnow-session-type": "control_ui",
      },
    });

    try {
      await connectOk(started.ws);

      const getRes = await rpcReq<{ hash?: string }>(started.ws, "config.get", {});
      expect(getRes.ok).toBe(true);
      const baseHash = getRes.payload?.hash;
      expect(typeof baseHash).toBe("string");

      const setRes = await rpcReq(started.ws, "config.set", {
        raw: JSON.stringify(
          {
            env: {
              CODING_PLAN_API_KEY: "sk-test-user",
            },
          },
          null,
          2,
        ),
        baseHash,
      });
      expect(setRes.ok).toBe(true);

      const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        env?: Record<string, string>;
        gateway?: {
          auth?: {
            mode?: string;
            trustedProxy?: {
              userHeader?: string;
              requiredHeaders?: string[];
            };
          };
          trustedProxies?: string[];
          controlUi?: {
            basePath?: string;
            root?: string;
            allowedOrigins?: string[];
            dangerouslyAllowHostHeaderOriginFallback?: boolean;
            dangerouslyDisableDeviceAuth?: boolean;
          };
        };
      };

      expect(saved.env?.CODING_PLAN_API_KEY).toBe("sk-test-user");
      expect(saved.gateway?.auth?.mode).toBe("trusted-proxy");
      expect(saved.gateway?.auth?.trustedProxy?.userHeader).toBe("x-forwarded-user");
      expect(saved.gateway?.auth?.trustedProxy?.requiredHeaders).toEqual([
        "x-clawnow-verified",
        "x-clawnow-instance-id",
        "x-clawnow-session-type",
      ]);
      expect(saved.gateway?.trustedProxies).toEqual(["127.0.0.1", "::1"]);
      expect(saved.gateway?.controlUi?.basePath).toBe("/clawnow");
      expect(saved.gateway?.controlUi?.root).toBe("/opt/clawnow/control-ui/current");
      expect(saved.gateway?.controlUi?.allowedOrigins).toEqual(["http://127.0.0.1:18790"]);
      expect(saved.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback).toBe(true);
      expect(saved.gateway?.controlUi?.dangerouslyDisableDeviceAuth).toBe(true);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
