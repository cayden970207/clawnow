"use client";

import { ArrowLeft, ExternalLink, Loader2, RefreshCw, Server, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AuthModal } from "@/components/AuthModal";
import { useAuth } from "@/contexts/authContext";

type ClawInstanceStatus =
  | "provisioning"
  | "running"
  | "recovering"
  | "stopped"
  | "error"
  | "deleting"
  | "terminated";

type OnboardingWizardStatus = "running" | "done" | "cancelled" | "error";
type OnboardingStepType =
  | "note"
  | "select"
  | "text"
  | "confirm"
  | "multiselect"
  | "progress"
  | "action";
type WorkspaceStage = "deploy" | "booting" | "wizard" | "gateway";

interface ClawInstance {
  id: string;
  status: ClawInstanceStatus;
  hetzner_server_id: number | null;
  region: string;
  server_type: string;
  image: string;
  server_name: string;
  ipv4: string | null;
  ipv6: string | null;
  provisioned_at: string | null;
  updated_at: string;
  last_error: string | null;
  metadata?: Record<string, unknown>;
}

interface WorkspaceBillingSummary {
  status: "ok" | "unavailable";
  currency: "USD";
  organizationMembershipCount: number;
  organizationSubscriptionCount: number;
  organizationPrepaidBalance: number;
  message?: string;
}

interface OnboardingWizardStepOption {
  value: unknown;
  label: string;
  hint?: string;
}

interface OnboardingWizardStep {
  id: string;
  type: OnboardingStepType;
  title?: string;
  message?: string;
  options?: OnboardingWizardStepOption[];
  initialValue?: unknown;
  placeholder?: string;
  sensitive?: boolean;
  executor?: "gateway" | "client";
}

interface OnboardingWizardResult {
  done: boolean;
  step?: OnboardingWizardStep;
  status?: OnboardingWizardStatus;
  error?: string;
}

const POLLING_STATUSES = new Set<ClawInstanceStatus>(["provisioning", "recovering"]);
const CLAWNOW_LOADING_LINES = [
  "Preparing your OpenClaw workspace.",
  "Provisioning secure gateway and trusted-proxy channels.",
  "Cloud control loop is warming up - steady.",
  "If this takes a moment, it is compiling your first stable session.",
  "ClawNow is stretching the octopus for focus mode.",
  "Running a sanity check: no claws left behind.",
  "Warming the browser automation pipeline.",
  "Your workspace is almost ready, holding steady.",
] as const;
const DEFAULT_BOOTING_NOTICE = "OpenClaw is warming up. First boot can take around 3-10 minutes.";
const OPENCLAW_BROWSER_DOC_URL = "https://docs.openclaw.ai/tools/browser";

class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = "REQUEST_FAILED", status = 500) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

function getStatusLabel(status?: ClawInstanceStatus): string {
  if (!status) {
    return "Not Provisioned";
  }
  if (status === "running") {
    return "Ready";
  }
  if (status === "provisioning") {
    return "Starting";
  }
  if (status === "recovering") {
    return "Recovering";
  }
  if (status === "stopped") {
    return "Stopped";
  }
  if (status === "deleting") {
    return "Deleting";
  }
  if (status === "terminated") {
    return "Terminated";
  }
  return "Error";
}

function getStatusClass(status?: ClawInstanceStatus): string {
  if (status === "running") {
    return "bg-[#E8F5E9] text-[#0B7A2A] border-[#CDEAD3]";
  }
  if (status === "provisioning" || status === "recovering") {
    return "bg-[#FFF8E1] text-[#8A6400] border-[#F3E4B4]";
  }
  if (status === "error" || status === "stopped") {
    return "bg-[#FDECEC] text-[#B3261E] border-[#F6CACA]";
  }
  return "bg-[#F5F5F5] text-[#666] border-[#E7E7E7]";
}

function formatCurrencyUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function isOnboardingStepType(value: unknown): value is OnboardingStepType {
  return (
    value === "note" ||
    value === "select" ||
    value === "text" ||
    value === "confirm" ||
    value === "multiselect" ||
    value === "progress" ||
    value === "action"
  );
}

function isOnboardingStatus(value: unknown): value is OnboardingWizardStatus {
  return value === "running" || value === "done" || value === "cancelled" || value === "error";
}

function normalizeWizardResult(raw: unknown): OnboardingWizardResult {
  if (!raw || typeof raw !== "object") {
    return {
      done: true,
      status: "error",
      error: "Invalid onboarding response",
    };
  }
  const payload = raw as {
    done?: unknown;
    status?: unknown;
    error?: unknown;
    step?: unknown;
  };
  const done = typeof payload.done === "boolean" ? payload.done : false;
  const normalized: OnboardingWizardResult = { done };

  if (isOnboardingStatus(payload.status)) {
    normalized.status = payload.status;
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    normalized.error = payload.error;
  }

  const stepRaw = payload.step;
  if (!stepRaw || typeof stepRaw !== "object") {
    return normalized;
  }

  const stepPayload = stepRaw as {
    id?: unknown;
    type?: unknown;
    title?: unknown;
    message?: unknown;
    options?: unknown;
    initialValue?: unknown;
    placeholder?: unknown;
    sensitive?: unknown;
    executor?: unknown;
  };
  const stepId = typeof stepPayload.id === "string" ? stepPayload.id.trim() : "";
  if (!stepId || !isOnboardingStepType(stepPayload.type)) {
    return normalized;
  }

  const options = Array.isArray(stepPayload.options)
    ? stepPayload.options
        .map((option) => {
          if (!option || typeof option !== "object") {
            return null;
          }
          const optionPayload = option as { label?: unknown; hint?: unknown; value?: unknown };
          if (typeof optionPayload.label !== "string" || !optionPayload.label.trim()) {
            return null;
          }
          return {
            value: optionPayload.value,
            label: optionPayload.label,
            ...(typeof optionPayload.hint === "string" && optionPayload.hint.trim()
              ? {
                  hint: optionPayload.hint,
                }
              : {}),
          } satisfies OnboardingWizardStepOption;
        })
        .filter((option): option is OnboardingWizardStepOption => option !== null)
    : undefined;

  normalized.step = {
    id: stepId,
    type: stepPayload.type,
    ...(typeof stepPayload.title === "string" ? { title: stepPayload.title } : {}),
    ...(typeof stepPayload.message === "string" ? { message: stepPayload.message } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(stepPayload.initialValue !== undefined ? { initialValue: stepPayload.initialValue } : {}),
    ...(typeof stepPayload.placeholder === "string"
      ? { placeholder: stepPayload.placeholder }
      : {}),
    ...(typeof stepPayload.sensitive === "boolean" ? { sensitive: stepPayload.sensitive } : {}),
    ...(stepPayload.executor === "gateway" || stepPayload.executor === "client"
      ? {
          executor: stepPayload.executor,
        }
      : {}),
  };

  return normalized;
}

function deriveInitialStepValue(step: OnboardingWizardStep): unknown {
  if (step.type === "text") {
    if (typeof step.initialValue === "string") {
      return step.initialValue;
    }
    if (typeof step.initialValue === "number" || typeof step.initialValue === "boolean") {
      return String(step.initialValue);
    }
    return "";
  }
  if (step.type === "confirm") {
    return Boolean(step.initialValue);
  }
  if (step.type === "multiselect") {
    return Array.isArray(step.initialValue) ? [...step.initialValue] : [];
  }
  if (step.type === "select") {
    if (step.initialValue !== undefined) {
      return step.initialValue;
    }
    return step.options?.[0]?.value;
  }
  return null;
}

function stepRequiresAnswer(step: OnboardingWizardStep): boolean {
  return (
    step.type === "select" ||
    step.type === "text" ||
    step.type === "confirm" ||
    step.type === "multiselect"
  );
}

function isGatewayHandshakeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /invalid handshake|first request must be connect/i.test(error.message);
}

function isGatewayWebSocketOpenError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /gateway websocket failed to open/i.test(error.message);
}

function isRedirectUrlInputStep(step: OnboardingWizardStep | null): boolean {
  if (!step || step.type !== "text") {
    return false;
  }
  const combined =
    `${step.title || ""} ${step.message || ""} ${step.placeholder || ""}`.toLowerCase();
  return combined.includes("redirect url");
}

function isValueSelected(list: unknown[], value: unknown): boolean {
  return list.some((item) => Object.is(item, value));
}

function isInstanceOnboardingComplete(instance: ClawInstance | null): boolean {
  if (!instance) {
    return false;
  }
  const metadata =
    instance.metadata && typeof instance.metadata === "object" ? instance.metadata : {};
  const directCompleted = (metadata as { onboarding_completed?: unknown }).onboarding_completed;
  if (typeof directCompleted === "boolean") {
    return directCompleted;
  }
  const completedAt = (metadata as { onboarding_completed_at?: unknown }).onboarding_completed_at;
  return typeof completedAt === "string" && completedAt.trim().length > 0;
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.success) {
    const message = typeof json.error === "string" ? json.error : "Request failed";
    const code = typeof json.errorCode === "string" ? json.errorCode : "REQUEST_FAILED";
    throw new ApiError(message, code, response.status);
  }
  return json as T;
}

export default function ClawNowPage() {
  const router = useRouter();
  const { user, isLoading: isAuthLoading, getAuthHeaders } = useAuth();

  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [instance, setInstance] = useState<ClawInstance | null>(null);
  const [billing, setBilling] = useState<WorkspaceBillingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [hasLoaded, setHasLoaded] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [repairingGatewayDefaults, setRepairingGatewayDefaults] = useState(false);
  const [openingControlUi, setOpeningControlUi] = useState(false);
  const [refreshingHealth, setRefreshingHealth] = useState(false);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);

  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingSessionId, setOnboardingSessionId] = useState<string | null>(null);
  const [onboardingStep, setOnboardingStep] = useState<OnboardingWizardStep | null>(null);
  const [onboardingStepValue, setOnboardingStepValue] = useState<unknown>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingWizardStatus | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingMessage, setOnboardingMessage] = useState<string | null>(null);
  const [onboardingOAuthUrl, setOnboardingOAuthUrl] = useState<string | null>(null);
  const [onboardingOAuthBusy, setOnboardingOAuthBusy] = useState(false);
  const [manualWizardMode, setManualWizardMode] = useState(false);

  const loadCurrent = useCallback(async () => {
    if (!user) {
      return;
    }
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch("/api/clawnow/instances/current", {
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await parseApiResponse<{
        instance: ClawInstance | null;
        billing?: WorkspaceBillingSummary;
      }>(response);
      setInstance(data.instance);
      setBilling(data.billing || null);
    } catch (err: unknown) {
      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      setError(
        isTimeout
          ? "Workspace loading timed out. Please refresh or try again in a moment."
          : err instanceof Error
            ? err.message
            : "Failed to load workspace",
      );
    } finally {
      clearTimeout(timeout);
      setHasLoaded(true);
    }
  }, [getAuthHeaders, user]);

  const handleProvision = useCallback(async () => {
    setProvisioning(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch("/api/clawnow/instances/provision", {
        method: "POST",
        headers,
      });
      const data = await parseApiResponse<{ instance: ClawInstance }>(response);
      setInstance(data.instance);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Provisioning failed");
    } finally {
      setProvisioning(false);
    }
  }, [getAuthHeaders]);

  const handleRefreshHealth = useCallback(
    async (silent = false) => {
      if (!silent) {
        setRefreshingHealth(true);
        setError(null);
      }

      try {
        const headers = await getAuthHeaders();
        const response = await fetch("/api/clawnow/instances/health?sync=1", {
          method: "GET",
          headers,
          cache: "no-store",
        });
        const data = await parseApiResponse<{ instance: ClawInstance | null; error?: string }>(
          response,
        );
        setInstance(data.instance);
        if (!silent && data.error) {
          setError(data.error);
        }
      } catch (err: unknown) {
        if (!silent) {
          setError(err instanceof Error ? err.message : "Health check failed");
        }
      } finally {
        if (!silent) {
          setRefreshingHealth(false);
        }
      }
    },
    [getAuthHeaders],
  );

  const handleRecover = useCallback(async () => {
    setRecovering(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch("/api/clawnow/instances/recover", {
        method: "POST",
        headers,
      });
      const data = await parseApiResponse<{ instance: ClawInstance }>(response);
      setInstance(data.instance);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Recovery failed");
    } finally {
      setRecovering(false);
    }
  }, [getAuthHeaders]);

  const handleRepairGatewayDefaults = useCallback(async () => {
    setRepairingGatewayDefaults(true);
    setError(null);
    setOnboardingMessage(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch("/api/clawnow/instances/repair-defaults", {
        method: "POST",
        headers,
      });
      const data = await parseApiResponse<{ instance: ClawInstance; changed: boolean }>(response);
      setInstance(data.instance);
      setOnboardingMessage(
        data.changed
          ? "Channels and VM browser defaults repaired. Open Gateway, then use Desktop Live."
          : "Channels and VM browser defaults are already up to date.",
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to repair gateway defaults");
    } finally {
      setRepairingGatewayDefaults(false);
    }
  }, [getAuthHeaders]);

  const handleOpenControlUi = useCallback(async () => {
    setOpeningControlUi(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch("/api/clawnow/instances/launch-control-ui", {
        method: "POST",
        headers,
      });
      const data = await parseApiResponse<{ launchUrl: string; instance: ClawInstance }>(response);
      setInstance(data.instance);
      window.open(data.launchUrl, "_blank", "noopener,noreferrer");
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === "INSTANCE_BOOTING") {
        setError(
          "Your VM is running, but OpenClaw is still booting (usually 1-3 minutes on first boot). We will keep syncing health automatically.",
        );
        setInstance((current) => (current ? { ...current, status: "provisioning" } : current));
        void handleRefreshHealth(true);
      } else if (err instanceof ApiError && err.code === "ONBOARDING_REQUIRED") {
        setError('Please complete "How would you like to cook your 🦞?" before launching gateway.');
      } else {
        setError(err instanceof Error ? err.message : "Failed to open Control UI");
      }
    } finally {
      setOpeningControlUi(false);
    }
  }, [getAuthHeaders, handleRefreshHealth]);

  const applyOnboardingResult = useCallback((rawResult: unknown) => {
    const result = normalizeWizardResult(rawResult);
    setOnboardingStatus(result.status || null);
    setOnboardingError(result.error || null);

    if (result.done || !result.step) {
      setOnboardingStep(null);
      setOnboardingStepValue(null);
      return result;
    }

    setOnboardingStep(result.step);
    setOnboardingStepValue(deriveInitialStepValue(result.step));
    return result;
  }, []);

  const handleStartTerminalOnboarding = useCallback(async () => {
    setOnboardingBusy(true);
    setOnboardingError(null);
    setOnboardingMessage(null);
    setOnboardingOAuthUrl(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch("/api/clawnow/instances/onboarding/start", {
        method: "POST",
        headers,
      });
      const data = await parseApiResponse<{
        sessionId: string;
        result: unknown;
        instance: ClawInstance;
      }>(response);
      setInstance(data.instance);
      setOnboardingSessionId(data.sessionId);
      const result = applyOnboardingResult(data.result);
      if (result.done) {
        setOnboardingSessionId(null);
        setManualWizardMode(false);
        setOnboardingMessage(
          result.status === "done"
            ? "Setup completed. Next: open Gateway and use Desktop Live to observe VM browser actions."
            : result.error || "Onboarding completed.",
        );
      }
    } catch (err: unknown) {
      if (isGatewayWebSocketOpenError(err)) {
        // The VM is reachable but the gateway is not ready yet (or restarting).
        // Syncing health will downgrade the instance to "Starting" until the gateway responds.
        void handleRefreshHealth(true);
      }
      setOnboardingError(err instanceof Error ? err.message : "Failed to start onboarding");
    } finally {
      setOnboardingBusy(false);
    }
  }, [applyOnboardingResult, getAuthHeaders, handleRefreshHealth]);

  const handleOpenOnboardingOAuthLogin = useCallback(async () => {
    if (onboardingOAuthUrl) {
      window.open(onboardingOAuthUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setOnboardingOAuthBusy(true);
    setOnboardingError(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `/api/clawnow/instances/onboarding/codex-auth-url?ts=${Date.now()}`,
        {
          method: "GET",
          headers,
          cache: "no-store",
        },
      );
      const data = await parseApiResponse<{
        instance: ClawInstance;
        authUrl: string | null;
      }>(response);
      setInstance(data.instance);
      setOnboardingOAuthUrl(data.authUrl);
      if (!data.authUrl) {
        setOnboardingError(
          "ChatGPT login URL is not ready yet. Please click again in 1-2 seconds.",
        );
        return;
      }
      window.open(data.authUrl, "_blank", "noopener,noreferrer");
    } catch (err: unknown) {
      setOnboardingError(err instanceof Error ? err.message : "Failed to fetch ChatGPT login URL");
    } finally {
      setOnboardingOAuthBusy(false);
    }
  }, [getAuthHeaders, onboardingOAuthUrl]);

  const handleSubmitTerminalOnboardingStep = useCallback(async () => {
    if (!onboardingSessionId) {
      setOnboardingError("Onboarding session not found. Start again.");
      return;
    }

    let answer:
      | {
          stepId: string;
          value: unknown;
        }
      | undefined;
    if (onboardingStep) {
      if (onboardingStep.type === "multiselect") {
        answer = {
          stepId: onboardingStep.id,
          value: Array.isArray(onboardingStepValue) ? onboardingStepValue : [],
        };
      } else if (onboardingStep.type === "confirm") {
        answer = {
          stepId: onboardingStep.id,
          value: Boolean(onboardingStepValue),
        };
      } else if (onboardingStep.type === "text") {
        answer = {
          stepId: onboardingStep.id,
          value: typeof onboardingStepValue === "string" ? onboardingStepValue : "",
        };
      } else if (onboardingStep.type === "select") {
        const fallbackValue = onboardingStep.options?.[0]?.value;
        const selectedValue =
          onboardingStepValue !== undefined && onboardingStepValue !== null
            ? onboardingStepValue
            : fallbackValue;
        if (selectedValue === undefined) {
          setOnboardingError("No selectable option available for this step.");
          return;
        }
        answer = {
          stepId: onboardingStep.id,
          value: selectedValue,
        };
      } else {
        // Gateway wizard sessions require acknowledging note/action/progress
        // steps with a stepId so the runner can advance.
        answer = {
          stepId: onboardingStep.id,
          value: null,
        };
      }
    }

    setOnboardingBusy(true);
    setOnboardingError(null);
    setOnboardingMessage(null);
    try {
      const maxAttempts = 4;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const headers = await getAuthHeaders();
          const response = await fetch("/api/clawnow/instances/onboarding/next", {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              sessionId: onboardingSessionId,
              ...(answer ? { answer } : {}),
            }),
          });
          const data = await parseApiResponse<{
            result: unknown;
            instance: ClawInstance;
          }>(response);
          setInstance(data.instance);
          const result = applyOnboardingResult(data.result);
          if (result.done) {
            setOnboardingSessionId(null);
            setManualWizardMode(false);
            setOnboardingOAuthUrl(null);
            setOnboardingMessage(
              result.status === "done"
                ? "Setup completed. Next: open Gateway and use Desktop Live to observe VM browser actions."
                : result.error || "Onboarding finished.",
            );
          }
          return;
        } catch (err: unknown) {
          const retryable = isGatewayHandshakeError(err) || isGatewayWebSocketOpenError(err);
          if (attempt < maxAttempts - 1 && retryable) {
            const delay = 150 + attempt * 250;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === "WIZARD_SESSION_EXPIRED") {
        setOnboardingSessionId(null);
        setOnboardingStep(null);
        setOnboardingStepValue(null);
        setOnboardingOAuthUrl(null);
      }
      if (err instanceof ApiError && err.code === "GATEWAY_WARMING_UP") {
        void handleRefreshHealth(true);
      }
      if (isGatewayWebSocketOpenError(err)) {
        void handleRefreshHealth(true);
      }
      setOnboardingError(err instanceof Error ? err.message : "Failed to continue onboarding");
    } finally {
      setOnboardingBusy(false);
    }
  }, [
    applyOnboardingResult,
    getAuthHeaders,
    handleRefreshHealth,
    onboardingSessionId,
    onboardingStep,
    onboardingStepValue,
  ]);

  const handleCancelTerminalOnboarding = useCallback(async () => {
    if (!onboardingSessionId) {
      setOnboardingSessionId(null);
      setOnboardingStep(null);
      setOnboardingStepValue(null);
      setOnboardingStatus(null);
      setOnboardingOAuthUrl(null);
      return;
    }

    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch("/api/clawnow/instances/onboarding/cancel", {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId: onboardingSessionId }),
      });
      const data = await parseApiResponse<{
        instance: ClawInstance;
        status: {
          status?: unknown;
          error?: unknown;
        };
      }>(response);
      setInstance(data.instance);
      setOnboardingSessionId(null);
      setOnboardingStep(null);
      setOnboardingStepValue(null);
      setOnboardingStatus(
        isOnboardingStatus(data.status?.status) ? data.status.status : "cancelled",
      );
      setOnboardingError(typeof data.status?.error === "string" ? data.status.error : null);
      setOnboardingMessage("Onboarding wizard cancelled.");
      setOnboardingOAuthUrl(null);
      setManualWizardMode(false);
    } catch (err: unknown) {
      setOnboardingError(err instanceof Error ? err.message : "Failed to cancel onboarding");
    } finally {
      setOnboardingBusy(false);
    }
  }, [getAuthHeaders, onboardingSessionId]);

  useEffect(() => {
    if (user) {
      void loadCurrent();
    }
  }, [user, loadCurrent]);

  useEffect(() => {
    setOnboardingSessionId(null);
    setOnboardingStep(null);
    setOnboardingStepValue(null);
    setOnboardingStatus(null);
    setOnboardingError(null);
    setOnboardingMessage(null);
    setOnboardingOAuthUrl(null);
    setManualWizardMode(false);
  }, [instance?.id]);

  useEffect(() => {
    setOnboardingOAuthUrl(null);
  }, [onboardingStep?.id]);

  const isBooting = useMemo(() => {
    if (!instance) {
      return false;
    }
    if (POLLING_STATUSES.has(instance.status)) {
      return true;
    }
    return instance.status === "running" && !instance.provisioned_at;
  }, [instance]);

  useEffect(() => {
    if (!isBooting) {
      return;
    }
    const timer = setInterval(() => {
      void handleRefreshHealth(true);
    }, 12000);
    return () => clearInterval(timer);
  }, [isBooting, handleRefreshHealth]);

  const canOpenSession = useMemo(
    () => instance?.status === "running" && Boolean(instance.provisioned_at),
    [instance?.status, instance?.provisioned_at],
  );
  const onboardingCompleted = useMemo(() => isInstanceOnboardingComplete(instance), [instance]);
  const canLaunchGateway = canOpenSession && onboardingCompleted;
  const isWorkspaceLoading = isAuthLoading || (!!user && !hasLoaded);
  const hasProvisionedServer = Boolean(instance?.hetzner_server_id);
  const workspaceStage = useMemo<WorkspaceStage>(() => {
    if (
      !instance ||
      instance.status === "terminated" ||
      (!hasProvisionedServer && instance.status !== "provisioning")
    ) {
      return "deploy";
    }
    if (isBooting) {
      return "booting";
    }
    if (canOpenSession && !onboardingCompleted) {
      return "wizard";
    }
    return "gateway";
  }, [canOpenSession, hasProvisionedServer, instance, isBooting, onboardingCompleted]);
  const showHelpActions =
    hasProvisionedServer &&
    (instance?.status === "error" ||
      instance?.status === "stopped" ||
      instance?.status === "recovering");
  const showWizardSection =
    canOpenSession &&
    (workspaceStage === "wizard" || manualWizardMode || onboardingSessionId !== null);
  const showOAuthLoginShortcut = isRedirectUrlInputStep(onboardingStep);
  const isPreparingOrStarting = isWorkspaceLoading || workspaceStage === "booting";
  const loadingLine = CLAWNOW_LOADING_LINES[loadingMessageIndex];
  const organizationBalanceSummary = useMemo(() => {
    if (!billing) {
      return {
        value: "—",
        detail: "Organization balance is syncing.",
        tone: "neutral" as const,
      };
    }
    if (billing.status === "unavailable") {
      return {
        value: "Unavailable",
        detail: billing.message || "Organization billing data is temporarily unavailable.",
        tone: "warning" as const,
      };
    }
    if (billing.organizationMembershipCount === 0) {
      return {
        value: formatCurrencyUsd(0),
        detail: "No linked organization membership yet.",
        tone: "neutral" as const,
      };
    }

    const orgLabel =
      billing.organizationSubscriptionCount === 1
        ? "active organization subscription"
        : "active organization subscriptions";
    if (billing.organizationSubscriptionCount === 0) {
      return {
        value: formatCurrencyUsd(0),
        detail: `Linked to ${billing.organizationMembershipCount} organizations, but no active CreateNow prepaid subscription found.`,
        tone: "neutral" as const,
      };
    }

    return {
      value: formatCurrencyUsd(billing.organizationPrepaidBalance),
      detail: `Across ${billing.organizationSubscriptionCount} ${orgLabel}.`,
      tone: "positive" as const,
    };
  }, [billing]);

  const bootingWarnings = useMemo(() => {
    const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
    const notices: string[] = [];
    const seen = new Set<string>();
    const addNotice = (value: string | null | undefined) => {
      const message = typeof value === "string" ? value.trim() : "";
      if (!message) {
        return;
      }
      const key = normalize(message);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      notices.push(message);
    };

    addNotice(error);
    addNotice(instance?.last_error);

    const defaultKey = normalize(DEFAULT_BOOTING_NOTICE);
    const hasNonDefaultNotice = notices.some((message) => normalize(message) !== defaultKey);
    if (!hasNonDefaultNotice) {
      addNotice(DEFAULT_BOOTING_NOTICE);
    }

    return notices;
  }, [error, instance?.last_error]);

  useEffect(() => {
    if (!canOpenSession) {
      setManualWizardMode(false);
    }
  }, [canOpenSession]);

  useEffect(() => {
    if (!isPreparingOrStarting) {
      return;
    }
    const timer = setInterval(() => {
      setLoadingMessageIndex((current) => (current + 1) % CLAWNOW_LOADING_LINES.length);
    }, 2200);
    return () => clearInterval(timer);
  }, [isPreparingOrStarting]);

  return (
    <div className="min-h-screen bg-[#F7F7F5] text-[#191919]">
      <header className="sticky top-0 z-10 border-b border-[#ECECEC] bg-[#F7F7F5]/90 px-4 py-4 backdrop-blur md:px-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="inline-flex items-center gap-2 rounded-full border border-[#E4E4E4] bg-white px-3 py-1.5 text-sm text-[#666] transition hover:border-[#D8D8D8] hover:text-[#111]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className="hidden h-5 w-px bg-[#E7E7E7] md:block" />
          <p className="text-sm font-medium uppercase tracking-[0.22em] text-[#6D6D6D]">ClawNow</p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 py-10 md:px-8 md:py-14">
        {user && !isWorkspaceLoading && (
          <section
            className={`mb-6 rounded-2xl border px-4 py-3 ${
              organizationBalanceSummary.tone === "warning"
                ? "border-[#F1D1D1] bg-[#FFF6F6]"
                : organizationBalanceSummary.tone === "positive"
                  ? "border-[#DCEFD9] bg-[#F6FFF4]"
                  : "border-[#EAEAEA] bg-white"
            }`}
          >
            <p className="text-xs uppercase tracking-[0.14em] text-[#7A7A7A]">Organization Balance</p>
            <p className="mt-1 text-xl font-semibold tracking-tight text-[#111]">
              {organizationBalanceSummary.value}
            </p>
            <p className="mt-1 text-xs text-[#666]">{organizationBalanceSummary.detail}</p>
          </section>
        )}

        {isWorkspaceLoading ? (
          <section className="mx-auto max-w-3xl rounded-3xl border border-[#EAEAEA] bg-white p-8 shadow-[0_10px_35px_rgba(0,0,0,0.05)] md:p-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#E7E7E7] bg-[#FAFAFA] px-3 py-1 text-xs font-medium text-[#5F5F5F]">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#222]" />
              Starting workspace
            </div>

            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-[#111] md:text-4xl">
              Preparing your OpenClaw workspace
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[#666] md:text-base">
              <span className="block animate-pulse">{loadingLine}</span>
            </p>

            <div className="mt-7 space-y-3">
              <div className="flex items-center gap-3 rounded-2xl border border-[#EFEFEF] bg-[#FAFAFA] px-4 py-3 text-sm text-[#444]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[#111]" />
                Checking account session
              </div>
              <div className="flex items-center gap-3 rounded-2xl border border-[#EFEFEF] bg-[#FAFAFA] px-4 py-3 text-sm text-[#444]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[#111]" />
                Syncing your dedicated Claw instance
              </div>
              <div className="flex items-center gap-3 rounded-2xl border border-[#EFEFEF] bg-[#FAFAFA] px-4 py-3 text-sm text-[#444]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[#111]" />
                {loadingLine}
              </div>
            </div>

            <div className="mt-6 h-2 overflow-hidden rounded-full bg-[#ECECEC]">
              <div className="h-full w-2/5 animate-pulse rounded-full bg-[#111]" />
            </div>
            <p className="mt-3 text-xs text-[#7A7A7A]">
              Usually a few seconds. First boot may take around 1-3 minutes.
            </p>
          </section>
        ) : !user ? (
          <section className="mx-auto max-w-xl rounded-3xl border border-[#EAEAEA] bg-white p-8 text-center shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
            <h2 className="text-2xl font-semibold tracking-tight text-[#111]">
              Sign in to ClawNow
            </h2>
            <p className="mt-3 text-sm text-[#666]">
              Continue with your CreateNow auth to manage your dedicated OpenClaw VM.
            </p>
            <button
              onClick={() => setIsAuthModalOpen(true)}
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-[#111] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#2A2A2A]"
            >
              Continue with Email
            </button>
          </section>
        ) : workspaceStage === "deploy" ? (
          <section className="mx-auto max-w-3xl rounded-3xl border border-[#EAEAEA] bg-white p-8 shadow-[0_10px_35px_rgba(0,0,0,0.05)] md:p-12">
            <h1 className="text-4xl font-semibold tracking-tight text-[#111] md:text-5xl">
              Deploy your first 🦞
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[#555] md:text-base">
              Start your own OpenClaw cloud workspace in one click.
            </p>

            {instance && (
              <div className="mt-5 rounded-2xl border border-[#EFEFEF] bg-[#FAFAFA] px-4 py-3 text-sm text-[#555]">
                {instance.last_error || "No active VM found. Deploy a new one to continue."}
              </div>
            )}

            {error && (
              <div className="mt-6 rounded-2xl border border-[#F1D1D1] bg-[#FFF6F6] px-4 py-3 text-sm text-[#9D1B1B]">
                {error}
              </div>
            )}

            <button
              onClick={handleProvision}
              disabled={provisioning}
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-[#111] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#2A2A2A] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {provisioning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Server className="h-4 w-4" />
              )}
              {provisioning ? "Deploying Claw..." : "Deploy Claw"}
            </button>
          </section>
        ) : workspaceStage === "booting" ? (
          <section className="mx-auto max-w-3xl rounded-3xl border border-[#EAEAEA] bg-white p-8 shadow-[0_10px_35px_rgba(0,0,0,0.05)] md:p-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[#8A8A8A]">Workspace</p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight text-[#111]">OpenClaw</h2>
                <p className="mt-2 text-sm text-[#666]">
                  Deploy VM -&gt; Setup Wizard -&gt; Launch Gateway.
                </p>
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-xs font-medium ${getStatusClass(instance?.status)}`}
              >
                {getStatusLabel(instance?.status)}
              </span>
            </div>

            {bootingWarnings.map((warning, index) => (
              <div
                key={`booting-warning-${index}`}
                className="mt-4 rounded-2xl border border-[#F1D1D1] bg-[#FFF6F6] px-4 py-3 text-sm text-[#B3261E]"
              >
                {warning}
              </div>
            ))}

            <div className="mt-4 rounded-2xl border border-[#EFEFEF] bg-[#FAFAFA] px-4 py-4">
              <div className="flex items-center gap-2 text-sm font-medium text-[#1A1A1A]">
                <Loader2 className="h-4 w-4 animate-spin" />
                {loadingLine}
              </div>
              <p className="mt-2 text-xs text-[#666]">
                First boot can take around 1-3 minutes. We are syncing health automatically.
              </p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#ECECEC]">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-[#111]" />
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                onClick={() => void handleRefreshHealth(false)}
                disabled={refreshingHealth}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#ECECEC] bg-[#FAFAFA] px-3 py-1.5 text-xs font-medium text-[#666] transition hover:bg-[#F3F3F3] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {refreshingHealth ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Sync Health
              </button>

              <button
                onClick={handleRecover}
                disabled={recovering || !hasProvisionedServer}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#ECECEC] bg-[#FAFAFA] px-3 py-1.5 text-xs font-medium text-[#666] transition hover:bg-[#F3F3F3] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {recovering ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wrench className="h-4 w-4" />
                )}
                Recover VM
              </button>
            </div>
          </section>
        ) : showWizardSection ? (
          <section className="mx-auto max-w-3xl rounded-3xl border border-[#EAEAEA] bg-white p-6 shadow-[0_10px_35px_rgba(0,0,0,0.05)] md:p-8">
            <p className="text-xs uppercase tracking-[0.2em] text-[#8A8A8A]">Setup Wizard</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-[#111]">
              How would you like to cook your 🦞?
            </h2>
            <p className="mt-2 text-sm text-[#666]">
              Follow the prompts to connect your model and channels.
            </p>

            {manualWizardMode && onboardingCompleted && (
              <div className="mt-4">
                <button
                  onClick={() => setManualWizardMode(false)}
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-[#DCDCDC] bg-white px-5 py-2.5 text-sm font-semibold text-[#111] transition hover:bg-[#F6F6F6]"
                >
                  Back to Workspace
                </button>
              </div>
            )}

            {!onboardingSessionId ? (
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  onClick={handleStartTerminalOnboarding}
                  disabled={onboardingBusy || !canOpenSession}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[#111] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#2A2A2A] disabled:cursor-not-allowed disabled:bg-[#D9D9D9] disabled:text-[#8E8E8E]"
                >
                  {onboardingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {onboardingBusy ? "Starting wizard..." : "Start Cooking Wizard"}
                </button>
              </div>
            ) : (
              <div className="mt-4 inline-flex items-center rounded-full border border-[#DCDCDC] bg-white px-3 py-1 text-xs font-medium text-[#555]">
                Session active: {onboardingSessionId.slice(0, 8)}...
              </div>
            )}

            {onboardingStep && (
              <div className="mt-4 rounded-2xl border border-[#EFEFEF] bg-white p-4">
                {onboardingStep.title && (
                  <p className="text-sm font-semibold text-[#1A1A1A]">{onboardingStep.title}</p>
                )}
                {onboardingStep.message && (
                  <p className="mt-2 whitespace-pre-line text-sm text-[#555]">
                    {onboardingStep.message}
                  </p>
                )}

                {onboardingStep.type === "text" && (
                  <div className="mt-3 space-y-3">
                    <input
                      type={onboardingStep.sensitive ? "password" : "text"}
                      value={typeof onboardingStepValue === "string" ? onboardingStepValue : ""}
                      onChange={(event) => setOnboardingStepValue(event.target.value)}
                      placeholder={onboardingStep.placeholder || "Enter value"}
                      className="w-full rounded-2xl border border-[#E5E5E5] bg-white px-4 py-2.5 text-sm text-[#111] outline-none transition focus:border-[#BDBDBD]"
                      autoComplete="off"
                      spellCheck={false}
                    />

                    {showOAuthLoginShortcut && (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={handleOpenOnboardingOAuthLogin}
                          disabled={onboardingBusy || onboardingOAuthBusy || !canOpenSession}
                          className="inline-flex items-center gap-2 rounded-full border border-[#DCDCDC] bg-white px-4 py-2 text-sm font-medium text-[#111] transition hover:bg-[#F6F6F6] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {onboardingOAuthBusy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ExternalLink className="h-4 w-4" />
                          )}
                          {onboardingOAuthBusy ? "Preparing login URL..." : "Login with ChatGPT"}
                        </button>

                        <p className="text-xs text-[#777]">
                          Sign in, then copy the full callback URL and paste it above.
                        </p>

                        {onboardingOAuthUrl && (
                          <p className="w-full break-all text-xs text-[#666]">
                            Latest URL ready: {onboardingOAuthUrl}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {onboardingStep.type === "confirm" && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => setOnboardingStepValue(true)}
                      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                        onboardingStepValue
                          ? "bg-[#111] text-white"
                          : "border border-[#DCDCDC] bg-white text-[#555] hover:bg-[#F6F6F6]"
                      }`}
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setOnboardingStepValue(false)}
                      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                        onboardingStepValue === false
                          ? "bg-[#111] text-white"
                          : "border border-[#DCDCDC] bg-white text-[#555] hover:bg-[#F6F6F6]"
                      }`}
                    >
                      No
                    </button>
                  </div>
                )}

                {onboardingStep.type === "select" && (
                  <div className="mt-3 space-y-2">
                    {(onboardingStep.options || []).map((option, index) => (
                      <button
                        key={`${onboardingStep.id}-${index}`}
                        onClick={() => setOnboardingStepValue(option.value)}
                        className={`w-full rounded-2xl border px-3 py-2 text-left text-sm transition ${
                          Object.is(option.value, onboardingStepValue)
                            ? "border-[#111] bg-white text-[#111]"
                            : "border-[#E5E5E5] bg-white text-[#555] hover:border-[#CFCFCF]"
                        }`}
                      >
                        <p className="font-medium">{option.label}</p>
                        {option.hint && <p className="mt-0.5 text-xs text-[#777]">{option.hint}</p>}
                      </button>
                    ))}
                  </div>
                )}

                {onboardingStep.type === "multiselect" && (
                  <div className="mt-3 space-y-2">
                    {(onboardingStep.options || []).map((option, index) => {
                      const values = Array.isArray(onboardingStepValue) ? onboardingStepValue : [];
                      const checked = isValueSelected(values, option.value);
                      return (
                        <button
                          key={`${onboardingStep.id}-${index}`}
                          onClick={() =>
                            setOnboardingStepValue((current: unknown) => {
                              const list = Array.isArray(current) ? current : [];
                              if (isValueSelected(list, option.value)) {
                                return list.filter((entry) => !Object.is(entry, option.value));
                              }
                              return [...list, option.value];
                            })
                          }
                          className={`w-full rounded-2xl border px-3 py-2 text-left text-sm transition ${
                            checked
                              ? "border-[#111] bg-white text-[#111]"
                              : "border-[#E5E5E5] bg-white text-[#555] hover:border-[#CFCFCF]"
                          }`}
                        >
                          <p className="font-medium">
                            {checked ? "✓ " : ""}
                            {option.label}
                          </p>
                          {option.hint && (
                            <p className="mt-0.5 text-xs text-[#777]">{option.hint}</p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {onboardingSessionId && (
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  onClick={handleSubmitTerminalOnboardingStep}
                  disabled={onboardingBusy || !canOpenSession}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[#111] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#2A2A2A] disabled:cursor-not-allowed disabled:bg-[#D9D9D9] disabled:text-[#8E8E8E]"
                >
                  {onboardingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {onboardingBusy
                    ? "Running..."
                    : onboardingStep && stepRequiresAnswer(onboardingStep)
                      ? "Submit Step"
                      : "Continue"}
                </button>
                <button
                  onClick={handleCancelTerminalOnboarding}
                  disabled={onboardingBusy}
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-[#DCDCDC] bg-white px-5 py-2.5 text-sm font-semibold text-[#111] transition hover:bg-[#F6F6F6] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel Wizard
                </button>
              </div>
            )}

            {onboardingStatus && (
              <p className="mt-3 text-xs uppercase tracking-[0.14em] text-[#7A7A7A]">
                Status: {onboardingStatus}
              </p>
            )}

            {onboardingError && (
              <div className="mt-3 rounded-2xl border border-[#F1D1D1] bg-[#FFF6F6] px-4 py-3 text-sm text-[#9D1B1B]">
                {onboardingError}
              </div>
            )}

            {onboardingError && /gateway websocket failed to open/i.test(onboardingError) && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => void handleRefreshHealth(false)}
                  disabled={refreshingHealth}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#ECECEC] bg-[#FAFAFA] px-3 py-1.5 text-xs font-medium text-[#666] transition hover:bg-[#F3F3F3] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {refreshingHealth ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Sync Health
                </button>

                <button
                  onClick={handleRecover}
                  disabled={recovering || !hasProvisionedServer}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#ECECEC] bg-[#FAFAFA] px-3 py-1.5 text-xs font-medium text-[#666] transition hover:bg-[#F3F3F3] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {recovering ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wrench className="h-4 w-4" />
                  )}
                  Recover VM
                </button>
              </div>
            )}

            {onboardingMessage && (
              <div className="mt-3 rounded-2xl border border-[#EFEFEF] bg-white px-4 py-3 text-sm text-[#444]">
                {onboardingMessage}
              </div>
            )}
          </section>
        ) : (
          <section>
            <div className="rounded-3xl border border-[#EAEAEA] bg-white p-6 shadow-[0_10px_35px_rgba(0,0,0,0.05)] md:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-[#8A8A8A]">Workspace</p>
                  <h2 className="mt-2 text-3xl font-semibold tracking-tight text-[#111]">
                    OpenClaw
                  </h2>
                  <p className="mt-2 text-sm text-[#666]">
                    Your dedicated cloud workspace is ready when status turns Ready.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${getStatusClass(instance?.status)}`}
                  >
                    {getStatusLabel(instance?.status)}
                  </span>
                </div>
              </div>

              {error && (
                <div className="mt-4 rounded-2xl border border-[#F1D1D1] bg-[#FFF6F6] px-4 py-3 text-sm text-[#9D1B1B]">
                  {error}
                </div>
              )}

              {instance?.last_error && (
                <div className="mt-4 rounded-2xl border border-[#F1D1D1] bg-[#FFF6F6] px-4 py-3 text-sm text-[#9D1B1B]">
                  {instance.last_error}
                </div>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                {instance?.status === "error" ? (
                  <button
                    onClick={handleProvision}
                    disabled={provisioning}
                    className="inline-flex items-center gap-2 rounded-full bg-[#111] px-6 py-3 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(0,0,0,0.18)] transition hover:bg-[#2A2A2A] disabled:cursor-not-allowed disabled:bg-[#D9D9D9] disabled:text-[#8E8E8E]"
                  >
                    {provisioning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Server className="h-4 w-4" />
                    )}
                    {provisioning ? "Redeploying Claw..." : "Redeploy Claw"}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={handleOpenControlUi}
                      disabled={!canLaunchGateway || openingControlUi}
                      className="inline-flex items-center gap-2 rounded-full bg-[#111] px-6 py-3 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(0,0,0,0.18)] transition hover:bg-[#2A2A2A] disabled:cursor-not-allowed disabled:bg-[#D9D9D9] disabled:text-[#8E8E8E]"
                    >
                      {openingControlUi ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ExternalLink className="h-4 w-4" />
                      )}
                      {canLaunchGateway ? "Launch Gateway" : "Complete Setup Wizard First"}
                    </button>

                    {onboardingCompleted && canOpenSession && (
                      <button
                        onClick={() => {
                          setManualWizardMode(true);
                          setOnboardingError(null);
                          setOnboardingMessage(null);
                        }}
                        disabled={onboardingBusy || Boolean(onboardingSessionId)}
                        className="inline-flex items-center justify-center gap-2 rounded-full border border-[#DCDCDC] bg-white px-5 py-2.5 text-sm font-semibold text-[#111] transition hover:bg-[#F6F6F6] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Re-setup Wizard
                      </button>
                    )}

                    {canOpenSession && (
                      <button
                        onClick={handleRepairGatewayDefaults}
                        disabled={repairingGatewayDefaults || openingControlUi}
                        className="inline-flex items-center justify-center gap-2 rounded-full border border-[#DCDCDC] bg-white px-5 py-2.5 text-sm font-semibold text-[#111] transition hover:bg-[#F6F6F6] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {repairingGatewayDefaults ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Wrench className="h-4 w-4" />
                        )}
                        {repairingGatewayDefaults ? "Repairing..." : "Fix Channels & VM Browser"}
                      </button>
                    )}
                  </>
                )}
              </div>

              {canOpenSession && (
                <div className="mt-4 rounded-2xl border border-[#EFEFEF] bg-[#FAFAFA] px-4 py-3 text-sm text-[#555]">
                  <p>
                    Browser automation now focuses on <strong>VM-side browser</strong>. Launch Gateway,
                    then click <strong>Open Desktop Live</strong> in the Gateway top bar to watch the
                    agent operate in real time.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <a
                      href={OPENCLAW_BROWSER_DOC_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-2 rounded-full border border-[#DCDCDC] bg-white px-4 py-2 text-xs font-semibold text-[#111] transition hover:bg-[#F6F6F6]"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Browser Docs
                    </a>
                  </div>
                  <p className="mt-2 text-xs text-[#777]">
                    Recommended browser profile: <code>openclaw</code>. This route keeps execution in
                    the VM and visible via Desktop Live.
                  </p>
                </div>
              )}

              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  onClick={() => void handleRefreshHealth(false)}
                  disabled={refreshingHealth}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#ECECEC] bg-[#FAFAFA] px-3 py-1.5 text-xs font-medium text-[#666] transition hover:bg-[#F3F3F3] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {refreshingHealth ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Sync Health
                </button>

                <button
                  onClick={handleRecover}
                  disabled={recovering || !hasProvisionedServer}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#ECECEC] bg-[#FAFAFA] px-3 py-1.5 text-xs font-medium text-[#666] transition hover:bg-[#F3F3F3] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {recovering ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wrench className="h-4 w-4" />
                  )}
                  Recover VM
                </button>
              </div>

              {showHelpActions && (
                <p className="mt-3 text-xs text-[#8A8A8A]">
                  If status is not Ready, try Recover VM once, then launch gateway again.
                </p>
              )}

              {onboardingCompleted && (
                <p className="mt-3 text-xs text-[#0B7A2A]">
                  Setup wizard completed. Launch Gateway, then use Desktop Live to observe VM browser
                  actions.
                </p>
              )}

              {onboardingMessage && (
                <div className="mt-3 rounded-2xl border border-[#EFEFEF] bg-[#FAFAFA] px-4 py-3 text-sm text-[#444]">
                  {onboardingMessage}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <AuthModal isOpen={isAuthModalOpen} onClose={() => setIsAuthModalOpen(false)} />
    </div>
  );
}
