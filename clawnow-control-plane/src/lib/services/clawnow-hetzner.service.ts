interface HetznerIPv4Net {
  ip: string | null;
}

interface HetznerIPv6Net {
  ip: string | null;
}

interface HetznerPublicNet {
  ipv4: HetznerIPv4Net | null;
  ipv6: HetznerIPv6Net | null;
}

export interface HetznerServer {
  id: number;
  name: string;
  status: string;
  created: string;
  public_net: HetznerPublicNet;
}

interface HetznerCreateServerResponse {
  server: HetznerServer;
  action?: {
    id: number;
    command: string;
    status: string;
  };
}

interface HetznerGetServerResponse {
  server: HetznerServer;
}

interface HetznerActionResponse {
  action: {
    id: number;
    command: string;
    status: string;
  };
}

interface HetznerDeleteServerResponse {
  action?: {
    id: number;
    command: string;
    status: string;
  };
}

export interface HetznerCreateServerInput {
  name: string;
  serverType: string;
  image: string;
  location: string;
  sshKeys?: Array<number | string>;
  userData?: string;
  labels?: Record<string, string>;
  startAfterCreate?: boolean;
}

export interface HetznerCreateServerResult {
  server: HetznerServer;
  actionId: number | null;
}

export type HetznerServerAction = "poweron" | "reboot" | "shutdown";

export class HetznerApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "HetznerApiError";
    this.status = status;
    this.details = details;
  }
}

const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";

export class ClawNowHetznerService {
  private readonly token: string;

  constructor(apiToken: string) {
    this.token = apiToken;
  }

  private normalizeHeaders(initHeaders: RequestInit["headers"]): Record<string, string> {
    if (!initHeaders) {
      return {};
    }
    if (initHeaders instanceof Headers) {
      return Object.fromEntries(initHeaders.entries());
    }
    if (Array.isArray(initHeaders)) {
      return Object.fromEntries(initHeaders);
    }
    return initHeaders;
  }

  async createServer(input: HetznerCreateServerInput): Promise<HetznerCreateServerResult> {
    const payload = {
      name: input.name,
      server_type: input.serverType,
      image: input.image,
      location: input.location,
      ssh_keys: input.sshKeys,
      user_data: input.userData,
      labels: input.labels,
      start_after_create: input.startAfterCreate ?? true,
    };

    const data = await this.request<HetznerCreateServerResponse>("/servers", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    return {
      server: data.server,
      actionId: data.action?.id ?? null,
    };
  }

  async getServer(serverId: number): Promise<HetznerServer> {
    const data = await this.request<HetznerGetServerResponse>(`/servers/${serverId}`, {
      method: "GET",
    });
    return data.server;
  }

  async runAction(serverId: number, action: HetznerServerAction): Promise<void> {
    await this.request<HetznerActionResponse>(`/servers/${serverId}/actions/${action}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async deleteServer(serverId: number): Promise<void> {
    await this.request<HetznerDeleteServerResponse>(`/servers/${serverId}`, {
      method: "DELETE",
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const extraHeaders = this.normalizeHeaders(init.headers);
    const response = await fetch(`${HETZNER_API_BASE}${path}`, {
      ...init,
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });

    const textBody = await response.text();
    const jsonBody = textBody ? this.safeJsonParse(textBody) : null;

    if (!response.ok) {
      const message =
        this.readErrorMessage(jsonBody) || `Hetzner request failed with status ${response.status}`;
      throw new HetznerApiError(message, response.status, jsonBody);
    }

    return (jsonBody as T) || ({} as T);
  }

  private safeJsonParse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private readErrorMessage(body: unknown): string | null {
    if (!body || typeof body !== "object") {
      return null;
    }
    const maybeError = (body as { error?: { message?: string } }).error;
    if (maybeError?.message) {
      return maybeError.message;
    }
    return null;
  }
}
