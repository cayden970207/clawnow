"use client";

import { Loader2, X } from "lucide-react";
import React, { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function getAuthRedirectUrl() {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (envUrl) {
    return `${envUrl.replace(/\/$/, "")}/auth/callback`;
  }

  if (typeof window !== "undefined") {
    return `${window.location.origin}/auth/callback`;
  }

  return "http://localhost:3333/auth/callback";
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeMode, setCodeMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) {
    return null;
  }

  const sendCode = async () => {
    if (!email.trim()) {
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: getAuthRedirectUrl(),
        },
      });
      if (authError) {
        setError(authError.message);
      } else {
        setCodeMode(true);
        setMessage("We sent a login code to your email.");
      }
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async () => {
    if (!email.trim() || code.trim().length !== 6) {
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: "email",
      });
      if (verifyError) {
        setError(verifyError.message);
      } else {
        setMessage("Login successful.");
        setTimeout(() => onClose(), 300);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#101010] p-6 text-white">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Sign in to ClawNow</h2>
          <button
            onClick={onClose}
            className="rounded-lg border border-white/15 p-1.5 text-neutral-300 transition hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="h-11 w-full rounded-xl border border-white/15 bg-black/40 px-3 text-sm outline-none transition focus:border-white/40"
          />

          {codeMode && (
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="6-digit code"
              className="h-11 w-full rounded-xl border border-white/15 bg-black/40 px-3 text-center text-sm tracking-[0.2em] outline-none transition focus:border-white/40"
            />
          )}

          {error && (
            <div className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-neutral-200">
              {error}
            </div>
          )}
          {message && <div className="text-sm text-neutral-300">{message}</div>}

          <button
            onClick={codeMode ? verifyCode : sendCode}
            disabled={loading || !email.trim() || (codeMode && code.trim().length !== 6)}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {codeMode ? "Verify code" : "Send login code"}
          </button>
        </div>
      </div>
    </div>
  );
}
