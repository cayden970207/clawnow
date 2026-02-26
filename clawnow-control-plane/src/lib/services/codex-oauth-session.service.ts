import { randomUUID } from "crypto";
import { loginOpenAICodex } from "@mariozechner/pi-ai";

const SESSION_TTL_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 20 * 1000;
const COMPLETE_TIMEOUT_MS = 90 * 1000;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type OAuthCredentials = {
  access: string;
  refresh?: string;
  expires?: number;
  email?: string;
  accountId?: string;
};

type CodexOAuthSession = {
  id: string;
  userId: string;
  createdAtMs: number;
  authUrlDeferred: Deferred<string>;
  callbackDeferred: Deferred<string>;
  credentialDeferred: Deferred<OAuthCredentials>;
};

const sessions = new Map<string, CodexOAuthSession>();

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAtMs > SESSION_TTL_MS) {
      session.authUrlDeferred.reject(new Error("OAuth session expired"));
      session.callbackDeferred.reject(new Error("OAuth session expired"));
      session.credentialDeferred.reject(new Error("OAuth session expired"));
      sessions.delete(sessionId);
    }
  }
}

function toOauthCredential(raw: unknown): OAuthCredentials {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const access = typeof record.access === "string" ? record.access.trim() : "";
  if (!access) {
    throw new Error("OAuth flow did not return an access token");
  }
  return {
    access,
    refresh: typeof record.refresh === "string" ? record.refresh : undefined,
    expires:
      typeof record.expires === "number" && Number.isFinite(record.expires)
        ? record.expires
        : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
    accountId: typeof record.accountId === "string" ? record.accountId : undefined,
  };
}

export class CodexOAuthSessionService {
  async start(userId: string): Promise<{ sessionId: string; authUrl: string }> {
    cleanupExpiredSessions();
    const sessionId = randomUUID();
    const session: CodexOAuthSession = {
      id: sessionId,
      userId,
      createdAtMs: Date.now(),
      authUrlDeferred: createDeferred<string>(),
      callbackDeferred: createDeferred<string>(),
      credentialDeferred: createDeferred<OAuthCredentials>(),
    };
    sessions.set(sessionId, session);

    void (async () => {
      try {
        const creds = await loginOpenAICodex({
          onAuth: async ({ url }) => {
            session.authUrlDeferred.resolve(url);
          },
          onPrompt: async () => await session.callbackDeferred.promise,
          onProgress: () => {},
        });
        session.credentialDeferred.resolve(toOauthCredential(creds));
      } catch (error: unknown) {
        const normalized = error instanceof Error ? error : new Error("OpenAI Codex OAuth failed");
        session.authUrlDeferred.reject(normalized);
        session.credentialDeferred.reject(normalized);
      }
    })();

    const authUrl = await withTimeout(
      session.authUrlDeferred.promise,
      START_TIMEOUT_MS,
      "Timed out while preparing OAuth URL. Please retry.",
    );
    return { sessionId, authUrl };
  }

  async complete(
    userId: string,
    sessionId: string,
    callbackUrl: string,
  ): Promise<OAuthCredentials> {
    cleanupExpiredSessions();
    const session = sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new Error("OAuth session not found or expired");
    }
    const trimmedCallbackUrl = callbackUrl.trim();
    if (!trimmedCallbackUrl) {
      throw new Error("Callback URL is required");
    }
    session.callbackDeferred.resolve(trimmedCallbackUrl);
    try {
      return await withTimeout(
        session.credentialDeferred.promise,
        COMPLETE_TIMEOUT_MS,
        "OAuth completion timed out. Please restart sign-in.",
      );
    } finally {
      sessions.delete(sessionId);
    }
  }
}

export const codexOAuthSessionService = new CodexOAuthSessionService();
