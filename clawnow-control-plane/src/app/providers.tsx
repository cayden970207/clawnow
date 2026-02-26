"use client";

import React from "react";
import { AuthProvider } from "@/contexts/authContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
