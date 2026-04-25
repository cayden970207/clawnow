import { NextRequest, NextResponse } from "next/server";
import { requireAuth, supabaseAdmin } from "@/lib/server-auth";
import { OctogenAgentService } from "@/lib/services/octogen-agent.service";
import { OctogenHermesAdapterService } from "@/lib/services/octogen-hermes-adapter.service";
import { OctogenService, OctogenServiceError } from "@/lib/services/octogen.service";
import type { OctogenRequestMeta } from "@/lib/services/octogen.service";

let octogenServiceSingleton: OctogenService | null = null;
let octogenAgentServiceSingleton: OctogenAgentService | null = null;
let octogenHermesAdapterServiceSingleton: OctogenHermesAdapterService | null = null;

export function createOctogenService() {
  if (!octogenServiceSingleton) {
    octogenServiceSingleton = new OctogenService();
  }
  return octogenServiceSingleton;
}

export function createOctogenAgentService() {
  if (!octogenAgentServiceSingleton) {
    octogenAgentServiceSingleton = new OctogenAgentService();
  }
  return octogenAgentServiceSingleton;
}

export function createOctogenHermesAdapterService() {
  if (!octogenHermesAdapterServiceSingleton) {
    octogenHermesAdapterServiceSingleton = new OctogenHermesAdapterService(
      createOctogenAgentService(),
    );
  }
  return octogenHermesAdapterServiceSingleton;
}

export interface OctogenWorkspaceMembership {
  id: string;
  name: string;
  slug: string | null;
}

type OrgAccessDenied = { authorized: false; response: NextResponse };
type OrgAccessGranted = {
  authorized: true;
  userId: string;
  workspaces: OctogenWorkspaceMembership[];
};
type OrgAccessContext = OrgAccessDenied | OrgAccessGranted;

type WorkspaceAccessGranted = OrgAccessGranted & {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string | null;
};
type WorkspaceAccessContext = OrgAccessDenied | WorkspaceAccessGranted;

interface OrganizationMembershipRow {
  organization_id: string;
  organizations?:
    | {
        id?: string | null;
        name?: string | null;
        slug?: string | null;
      }
    | {
        id?: string | null;
        name?: string | null;
        slug?: string | null;
      }[]
    | null;
}

function normalizeWorkspaceId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function readWorkspaceIdFromRequest(request: NextRequest): string | null {
  return (
    normalizeWorkspaceId(request.headers.get("x-octogen-workspace-id")) ||
    normalizeWorkspaceId(request.nextUrl.searchParams.get("workspaceId")) ||
    normalizeWorkspaceId(request.nextUrl.searchParams.get("orgId"))
  );
}

function membershipRowsToWorkspaces(
  rows: OrganizationMembershipRow[],
): OctogenWorkspaceMembership[] {
  const workspaces = new Map<string, OctogenWorkspaceMembership>();

  for (const row of rows) {
    const workspaceId = normalizeWorkspaceId(row.organization_id);
    if (!workspaceId) {
      continue;
    }

    if (!workspaces.has(workspaceId)) {
      workspaces.set(workspaceId, {
        id: workspaceId,
        name: "Workspace",
        slug: null,
      });
    }

    const rawOrg = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    if (!rawOrg || typeof rawOrg !== "object") {
      continue;
    }

    const workspace = workspaces.get(workspaceId);
    if (!workspace) {
      continue;
    }
    const name = normalizeWorkspaceId(rawOrg.name);
    const slug = normalizeWorkspaceId(rawOrg.slug);
    workspace.name = name || workspace.name;
    workspace.slug = slug || workspace.slug;
  }

  return [...workspaces.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function requireOctogenOrgAccess(request: NextRequest): Promise<OrgAccessContext> {
  const auth = await requireAuth(request);
  if (!auth.authorized) {
    return auth;
  }

  const { data, error } = await supabaseAdmin
    .from("organization_members")
    .select("organization_id, organizations(id, name, slug)")
    .eq("user_id", auth.userId);

  if (error) {
    return {
      authorized: false,
      response: NextResponse.json(
        {
          success: false,
          error: "Failed to verify organization access. Please try again.",
          errorCode: "ORG_MEMBERSHIP_CHECK_FAILED",
        },
        { status: 503 },
      ),
    };
  }

  const workspaces = membershipRowsToWorkspaces((data as OrganizationMembershipRow[] | null) || []);

  if (workspaces.length < 1) {
    return {
      authorized: false,
      response: NextResponse.json(
        {
          success: false,
          error: "Octogen Console is currently available to workspace members only.",
          errorCode: "ORG_MEMBERSHIP_REQUIRED",
        },
        { status: 403 },
      ),
    };
  }

  return {
    authorized: true,
    userId: auth.userId,
    workspaces,
  };
}

export async function requireOctogenWorkspaceAccess(
  request: NextRequest,
  options?: { workspaceId?: string | null },
): Promise<WorkspaceAccessContext> {
  const auth = await requireOctogenOrgAccess(request);
  if (!auth.authorized) {
    return auth;
  }

  const requestedWorkspaceId =
    normalizeWorkspaceId(options?.workspaceId) || readWorkspaceIdFromRequest(request);
  const workspace = requestedWorkspaceId
    ? auth.workspaces.find((candidate) => candidate.id === requestedWorkspaceId) || null
    : auth.workspaces.length === 1
      ? auth.workspaces[0]
      : null;

  if (requestedWorkspaceId && !workspace) {
    return {
      authorized: false,
      response: NextResponse.json(
        {
          success: false,
          error: "You do not have access to the selected workspace.",
          errorCode: "WORKSPACE_ACCESS_DENIED",
        },
        { status: 403 },
      ),
    };
  }

  if (!workspace) {
    return {
      authorized: false,
      response: NextResponse.json(
        {
          success: false,
          error: "Select a workspace before managing Octogen VMs.",
          errorCode: "WORKSPACE_REQUIRED",
        },
        { status: 400 },
      ),
    };
  }

  return {
    authorized: true,
    userId: auth.userId,
    workspaces: auth.workspaces,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
  };
}

export function toRequestMeta(request: NextRequest): OctogenRequestMeta {
  const originHeader = request.headers.get("origin");
  const refererHeader = request.headers.get("referer");
  let controlUiOrigin: string | null = null;
  if (originHeader) {
    controlUiOrigin = originHeader;
  } else if (refererHeader) {
    try {
      controlUiOrigin = new URL(refererHeader).origin;
    } catch {
      controlUiOrigin = null;
    }
  } else {
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
    if (forwardedHost) {
      try {
        controlUiOrigin = new URL(`${forwardedProto}://${forwardedHost}`).origin;
      } catch {
        controlUiOrigin = null;
      }
    }
  }

  return {
    ip:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      null,
    userAgent: request.headers.get("user-agent") || null,
    controlUiOrigin,
  };
}

export function octogenErrorResponse(error: unknown): NextResponse {
  if (error instanceof OctogenServiceError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        errorCode: error.code,
      },
      { status: error.status },
    );
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json(
    {
      success: false,
      error: message,
      errorCode: "INTERNAL_ERROR",
    },
    { status: 500 },
  );
}
