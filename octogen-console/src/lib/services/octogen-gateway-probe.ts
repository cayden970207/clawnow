export interface GatewayBootstrapStateSnapshot {
  phase: string | null;
  status: string | null;
  message: string | null;
}

export function describeGatewayPayloadError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const errorRaw = (payload as { error?: unknown }).error;
  const codeRaw = (payload as { code?: unknown }).code;
  const error = typeof errorRaw === "string" ? errorRaw.trim() : "";
  const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
  if (code && error) {
    return `${code}: ${error}`;
  }
  if (error) {
    return error;
  }
  if (code) {
    return code;
  }
  return null;
}

export function parseGatewayBootstrapState(payload: unknown): GatewayBootstrapStateSnapshot | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const phaseRaw = (payload as { phase?: unknown }).phase;
  const statusRaw = (payload as { status?: unknown }).status;
  const messageRaw = (payload as { message?: unknown }).message;

  const phase = typeof phaseRaw === "string" && phaseRaw.trim().length > 0 ? phaseRaw.trim() : null;
  const status =
    typeof statusRaw === "string" && statusRaw.trim().length > 0 ? statusRaw.trim() : null;
  const message =
    typeof messageRaw === "string" && messageRaw.trim().length > 0 ? messageRaw.trim() : null;

  if (!phase && !status && !message) {
    return null;
  }

  return { phase, status, message };
}

export function isGatewayBootstrapFailure(
  state: GatewayBootstrapStateSnapshot | null | undefined,
): boolean {
  if (!state) {
    return false;
  }
  return state.status?.toLowerCase() === "error" || state.phase?.toLowerCase() === "failed";
}

export function formatGatewayBootstrapFailureReason(
  state: GatewayBootstrapStateSnapshot | null | undefined,
): string | null {
  if (!isGatewayBootstrapFailure(state)) {
    return null;
  }

  const message = state?.message?.trim() ?? "";
  const phase = state?.phase?.trim() ?? "";
  if (message) {
    return phase && phase.toLowerCase() !== "failed"
      ? `Bootstrap failed during ${phase}: ${message}`
      : `Bootstrap failed: ${message}`;
  }
  if (phase) {
    return `Bootstrap failed during ${phase}`;
  }
  return "Bootstrap failed";
}
