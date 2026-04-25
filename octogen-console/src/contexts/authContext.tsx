"use client";

import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

interface AuthUser {
  id: string;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  session: Session | null;
  isLoading: boolean;
  getAuthHeaders: () => Promise<Record<string, string>>;
  refreshAuth: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const SESSION_LOAD_TIMEOUT_MS = 10_000;

function toAuthUser(session: Session | null): AuthUser | null {
  if (!session?.user) {
    return null;
  }
  return {
    id: session.user.id,
    email: session.user.email || "",
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const refreshInFlightRef = useRef<Promise<Session | null> | null>(null);

  const applySession = useCallback((nextSession: Session | null) => {
    setSession(nextSession);
    setUser(toAuthUser(nextSession));
  }, []);

  const refreshSessionOnce = useCallback(async (): Promise<Session | null> => {
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }

    const supabase = getSupabaseBrowserClient();
    refreshInFlightRef.current = supabase.auth
      .refreshSession()
      .then(({ data }) => data.session ?? null)
      .catch((error) => {
        console.warn("[AuthContext] refreshSession failed:", error);
        return null;
      })
      .finally(() => {
        refreshInFlightRef.current = null;
      });

    return refreshInFlightRef.current;
  }, []);

  const refreshAuth = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    applySession(currentSession);
  }, [applySession]);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    applySession(null);
  }, [applySession]);

  useEffect(() => {
    let disposed = false;
    // Guard against hanging auth SDK calls in transient local network conditions.
    const loadingTimeout = setTimeout(() => {
      if (!disposed) {
        setIsLoading(false);
      }
    }, SESSION_LOAD_TIMEOUT_MS);

    const supabase = getSupabaseBrowserClient();
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (disposed) {
          return;
        }
        applySession(data.session ?? null);
      })
      .catch((error) => {
        console.error("[AuthContext] Failed to initialize session:", error);
        if (disposed) {
          return;
        }
        applySession(null);
      })
      .finally(() => {
        if (!disposed) {
          setIsLoading(false);
        }
        clearTimeout(loadingTimeout);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, nextSession) => {
      if (disposed) {
        return;
      }

      if (!nextSession || event === "SIGNED_OUT") {
        applySession(null);
        setIsLoading(false);
        clearTimeout(loadingTimeout);
        return;
      }

      applySession(nextSession);
      setIsLoading(false);
      clearTimeout(loadingTimeout);
    });

    return () => {
      disposed = true;
      clearTimeout(loadingTimeout);
      subscription.unsubscribe();
    };
  }, [applySession]);

  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const supabase = getSupabaseBrowserClient();
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    const tokenFromState = session?.access_token;
    const {
      data: { session: current },
    } = await supabase.auth.getSession();
    const token = tokenFromState || current?.access_token;

    if (!token && current) {
      const refreshedSession = await refreshSessionOnce();
      if (refreshedSession?.access_token) {
        applySession(refreshedSession);
        headers.Authorization = `Bearer ${refreshedSession.access_token}`;
        return headers;
      }
    }

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }, [applySession, refreshSessionOnce, session?.access_token]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      isLoading,
      getAuthHeaders,
      refreshAuth,
      signOut,
    }),
    [user, session, isLoading, getAuthHeaders, refreshAuth, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
