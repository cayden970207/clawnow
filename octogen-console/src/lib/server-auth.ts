import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

let cachedAnon: SupabaseClient | null = null;
let cachedAdmin: SupabaseClient | null = null;

function readRequiredSupabaseEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    throw new Error(
      "Missing Supabase env vars. Required: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY",
    );
  }

  return { supabaseUrl, supabaseAnonKey, supabaseServiceKey };
}

function getSupabaseAnonClient(): SupabaseClient {
  if (cachedAnon) {
    return cachedAnon;
  }
  const { supabaseUrl, supabaseAnonKey } = readRequiredSupabaseEnv();
  cachedAnon = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedAnon;
}

function getSupabaseAdminClient(): SupabaseClient {
  if (cachedAdmin) {
    return cachedAdmin;
  }
  const { supabaseUrl, supabaseServiceKey } = readRequiredSupabaseEnv();
  cachedAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedAdmin;
}

export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, property) {
    return Reflect.get(getSupabaseAdminClient() as object, property);
  },
});

type AuthDenied = { authorized: false; response: NextResponse };
type AuthGranted = { authorized: true; userId: string };
type AuthContext = AuthDenied | AuthGranted;

function unauthorized(error: string, errorCode: string): AuthDenied {
  return {
    authorized: false,
    response: NextResponse.json(
      {
        success: false,
        error,
        errorCode,
      },
      { status: 401 },
    ),
  };
}

export async function requireAuth(request: NextRequest): Promise<AuthContext> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return unauthorized("Not authenticated", "NOT_AUTHENTICATED");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return unauthorized("Not authenticated", "NOT_AUTHENTICATED");
  }

  const {
    data: { user },
    error,
  } = await getSupabaseAnonClient().auth.getUser(token);
  if (error || !user) {
    return unauthorized("Invalid or expired session", "INVALID_SESSION");
  }

  return {
    authorized: true,
    userId: user.id,
  };
}
