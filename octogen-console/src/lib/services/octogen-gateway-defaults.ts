export const OCTOGEN_DEFAULT_CHANNEL_IDS = ["telegram", "whatsapp"] as const;
export const OPENAI_MEMORY_EMBED_MODEL = "text-embedding-3-small";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asTrimmedStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

export function buildOctogenTrustedProxyAllowUsersPatch(
  configRaw: unknown,
  trustedProxyUser: string,
  force: boolean,
): Record<string, unknown> | null {
  const user = trustedProxyUser.trim();
  if (!user) {
    return null;
  }

  const config = asObjectRecord(configRaw) ?? {};
  const gateway = asObjectRecord(config.gateway);
  const auth = asObjectRecord(gateway?.auth);
  const trustedProxy = asObjectRecord(auth?.trustedProxy);
  const allowUsers = asTrimmedStringArray(trustedProxy?.allowUsers) ?? [];

  const needsPatch = force
    ? allowUsers.length !== 1 || allowUsers[0] !== user
    : allowUsers.length === 0;
  if (!needsPatch) {
    return null;
  }

  return {
    gateway: {
      auth: {
        trustedProxy: {
          allowUsers: [user],
        },
      },
    },
  };
}

function buildManagedChannelPatch(params: {
  channelId: (typeof OCTOGEN_DEFAULT_CHANNEL_IDS)[number];
  channelConfig: Record<string, unknown> | null;
  force: boolean;
}): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const channelEnabled = params.channelConfig?.enabled;
  if (
    (params.force && channelEnabled !== true) ||
    (!params.force && channelEnabled === undefined)
  ) {
    patch.enabled = true;
  }

  if (params.channelId === "whatsapp") {
    const groupPolicy =
      typeof params.channelConfig?.groupPolicy === "string"
        ? params.channelConfig.groupPolicy.trim().toLowerCase()
        : "";
    const shouldPatchGroupPolicy = params.force ? groupPolicy !== "allowlist" : !groupPolicy;
    if (shouldPatchGroupPolicy) {
      patch.groupPolicy = "allowlist";
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function buildOctogenGatewayDefaultsPatch(
  configRaw: unknown,
  force: boolean,
): Record<string, unknown> | null {
  const config = asObjectRecord(configRaw) ?? {};
  const gateway = asObjectRecord(config.gateway);
  const controlUi = asObjectRecord(gateway?.controlUi);
  const browser = asObjectRecord(config.browser);
  const web = asObjectRecord(config.web);
  const tools = asObjectRecord(config.tools);
  const exec = asObjectRecord(tools?.exec);
  const channels = asObjectRecord(config.channels);
  const plugins = asObjectRecord(config.plugins);
  const pluginEntries = asObjectRecord(plugins?.entries);

  const patch: Record<string, unknown> = {};

  const gatewayPatch: Record<string, unknown> = {};
  const controlUiPatch: Record<string, unknown> = {};
  const controlUiFeatures = asObjectRecord(controlUi?.features);
  const trustProxyAuth = controlUi?.trustProxyAuth;
  const disableDeviceAuth = controlUi?.dangerouslyDisableDeviceAuth;
  if (trustProxyAuth !== true) {
    controlUiPatch.trustProxyAuth = true;
  }
  if (disableDeviceAuth === true) {
    controlUiPatch.dangerouslyDisableDeviceAuth = false;
  }
  const tasksFeatureEnabled = controlUiFeatures?.tasks;
  if ((force && tasksFeatureEnabled !== true) || (!force && tasksFeatureEnabled === undefined)) {
    controlUiPatch.features = {
      ...asObjectRecord(controlUiPatch.features),
      tasks: true,
    };
  }
  if (Object.keys(controlUiPatch).length > 0) {
    gatewayPatch.controlUi = controlUiPatch;
  }
  if (Object.keys(gatewayPatch).length > 0) {
    patch.gateway = gatewayPatch;
  }

  const browserPatch: Record<string, unknown> = {};
  const browserEnabled = browser?.enabled;
  if ((force && browserEnabled !== true) || (!force && browserEnabled === undefined)) {
    browserPatch.enabled = true;
  }
  const browserNoSandbox = browser?.noSandbox;
  if ((force && browserNoSandbox !== true) || (!force && browserNoSandbox === undefined)) {
    // Octogen Console gateway runs as root in VM bootstrap, so Chrome must use --no-sandbox.
    browserPatch.noSandbox = true;
  }
  const browserDefaultProfile =
    typeof browser?.defaultProfile === "string" ? browser.defaultProfile.trim() : "";
  const shouldPatchDefaultProfile = force
    ? browserDefaultProfile !== "openclaw"
    : !browserDefaultProfile || browserDefaultProfile === "chrome";
  if (shouldPatchDefaultProfile) {
    // Octogen Console defaults to VM-side managed browser so Desktop Live can mirror actions.
    // Keep user-custom profiles untouched.
    browserPatch.defaultProfile = "openclaw";
  }
  if (Object.keys(browserPatch).length > 0) {
    patch.browser = browserPatch;
  }

  const webEnabled = web?.enabled;
  if ((force && webEnabled !== true) || (!force && webEnabled === undefined)) {
    patch.web = { enabled: true };
  }

  const execPatch: Record<string, unknown> = {};
  const execSecurity = typeof exec?.security === "string" ? exec.security.trim().toLowerCase() : "";
  const shouldPatchExecSecurity = force
    ? execSecurity !== "allowlist"
    : !execSecurity || execSecurity === "full";
  if (shouldPatchExecSecurity) {
    execPatch.security = "allowlist";
  }
  const execAsk = typeof exec?.ask === "string" ? exec.ask.trim().toLowerCase() : "";
  const validExecAsk = execAsk === "off" || execAsk === "on-miss" || execAsk === "always";
  const shouldPatchExecAsk = force ? execAsk !== "on-miss" : !validExecAsk;
  if (shouldPatchExecAsk) {
    execPatch.ask = "on-miss";
  }
  if (Object.keys(execPatch).length > 0) {
    patch.tools = {
      exec: execPatch,
    };
  }

  const channelsPatch: Record<string, unknown> = {};
  const pluginEntriesPatch: Record<string, unknown> = {};
  for (const channelId of OCTOGEN_DEFAULT_CHANNEL_IDS) {
    const channelConfig = asObjectRecord(channels?.[channelId]);
    const channelPatch = buildManagedChannelPatch({
      channelId,
      channelConfig,
      force,
    });
    if (channelPatch) {
      channelsPatch[channelId] = channelPatch;
    }

    const pluginEntry = asObjectRecord(pluginEntries?.[channelId]);
    const pluginEnabled = pluginEntry?.enabled;
    if ((force && pluginEnabled !== true) || (!force && pluginEnabled === undefined)) {
      pluginEntriesPatch[channelId] = { enabled: true };
    }
  }
  if (Object.keys(channelsPatch).length > 0) {
    patch.channels = channelsPatch;
  }

  const pluginsPatch: Record<string, unknown> = {};
  if (Object.keys(pluginEntriesPatch).length > 0) {
    pluginsPatch.entries = pluginEntriesPatch;
  }

  const allow = asTrimmedStringArray(plugins?.allow);
  if (allow && allow.length > 0) {
    const missingAllow = OCTOGEN_DEFAULT_CHANNEL_IDS.filter((id) => !allow.includes(id));
    if (missingAllow.length > 0) {
      pluginsPatch.allow = [...allow, ...missingAllow];
    }
  }

  if (force) {
    const deny = asTrimmedStringArray(plugins?.deny);
    if (deny) {
      const managedChannelSet = new Set<string>(OCTOGEN_DEFAULT_CHANNEL_IDS);
      const nextDeny = deny.filter((entry) => !managedChannelSet.has(entry));
      if (nextDeny.length !== deny.length) {
        pluginsPatch.deny = nextDeny;
      }
    }
  }

  if (Object.keys(pluginsPatch).length > 0) {
    patch.plugins = pluginsPatch;
  }

  const agents = asObjectRecord(config.agents);
  const agentDefaults = asObjectRecord(agents?.defaults);
  const memorySearch = asObjectRecord(agentDefaults?.memorySearch);
  const memorySearchRemote = asObjectRecord(memorySearch?.remote);
  const memorySearchBatch = asObjectRecord(memorySearchRemote?.batch);
  const models = asObjectRecord(config.models);
  const providers = asObjectRecord(models?.providers);
  const openAiProvider = asObjectRecord(providers?.openai);

  const memorySearchPatch: Record<string, unknown> = {};
  const memoryRemotePatch: Record<string, unknown> = {};
  if (memorySearch?.enabled === undefined) {
    memorySearchPatch.enabled = true;
  }
  const memoryProvider =
    typeof memorySearch?.provider === "string" ? memorySearch.provider.trim() : "";
  if (!memoryProvider) {
    memorySearchPatch.provider = "openai";
  }
  const memoryModel = typeof memorySearch?.model === "string" ? memorySearch.model.trim() : "";
  if (!memoryModel) {
    memorySearchPatch.model = OPENAI_MEMORY_EMBED_MODEL;
  }
  const memoryFallback =
    typeof memorySearch?.fallback === "string" ? memorySearch.fallback.trim() : "";
  if (!memoryFallback) {
    memorySearchPatch.fallback = "openai";
  }
  const memoryRemoteApiKey =
    typeof memorySearchRemote?.apiKey === "string" ? memorySearchRemote.apiKey.trim() : "";
  const openAiApiKey =
    typeof openAiProvider?.apiKey === "string" ? openAiProvider.apiKey.trim() : "";
  if (!memoryRemoteApiKey && openAiApiKey) {
    memoryRemotePatch.apiKey = openAiApiKey;
  }

  const memoryBatchPatch: Record<string, unknown> = {};
  if (memorySearchBatch?.enabled === undefined) {
    memoryBatchPatch.enabled = true;
  }
  if (memorySearchBatch?.wait === undefined) {
    memoryBatchPatch.wait = true;
  }
  const batchConcurrency =
    typeof memorySearchBatch?.concurrency === "number" &&
    Number.isFinite(memorySearchBatch.concurrency)
      ? Math.max(1, Math.floor(memorySearchBatch.concurrency))
      : null;
  if (batchConcurrency === null) {
    memoryBatchPatch.concurrency = 2;
  }
  if (Object.keys(memoryBatchPatch).length > 0) {
    memoryRemotePatch.batch = memoryBatchPatch;
  }
  if (Object.keys(memoryRemotePatch).length > 0) {
    memorySearchPatch.remote = memoryRemotePatch;
  }

  if (Object.keys(memorySearchPatch).length > 0) {
    patch.agents = {
      defaults: {
        memorySearch: memorySearchPatch,
      },
    };
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
