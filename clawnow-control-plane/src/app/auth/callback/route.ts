import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const authError = searchParams.get("error");
  const authErrorCode = searchParams.get("error_code");
  const authErrorDescription = searchParams.get("error_description");
  const next = searchParams.get("next") ?? "/clawnow";

  const buildErrorRedirect = (fallbackCode?: string, fallbackDescription?: string) => {
    const url = new URL("/clawnow", origin);
    if (authError) {
      url.searchParams.set("error", authError);
    }
    if (authErrorCode || fallbackCode) {
      url.searchParams.set("error_code", authErrorCode || fallbackCode || "");
    }
    if (authErrorDescription || fallbackDescription) {
      url.searchParams.set("error_description", authErrorDescription || fallbackDescription || "");
    }
    return NextResponse.redirect(url.toString());
  };

  if (authError || authErrorCode) {
    return buildErrorRedirect();
  }

  if (!code) {
    return NextResponse.redirect(new URL("/clawnow", origin).toString());
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[AuthCallback] exchangeCodeForSession failed", error);
    return buildErrorRedirect("auth_code_exchange_failed", error.message);
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  const isLocalEnv = process.env.NODE_ENV === "development";

  if (isLocalEnv) {
    return NextResponse.redirect(new URL(next, origin).toString());
  }

  if (forwardedHost) {
    return NextResponse.redirect(`https://${forwardedHost}${next}`);
  }

  return NextResponse.redirect(new URL(next, origin).toString());
}
