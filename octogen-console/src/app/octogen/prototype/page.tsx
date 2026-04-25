"use client";

import {
  Activity,
  AlertTriangle,
  Bell,
  Boxes,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Cloud,
  Command,
  Cpu,
  Grid3X3,
  Layers3,
  Map,
  Maximize2,
  MessageCircle,
  MoreHorizontal,
  PackageCheck,
  Plus,
  Send,
  Settings,
  Sparkles,
  Wifi,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useMemo, useState } from "react";

type PodStatus = "ready" | "needs_provider" | "provisioning" | "running" | "error";
type ViewMode = "live" | "status" | "setup";
type OrbitKind = "provider" | "whatsapp" | "telegram" | "skill" | "task" | "logs" | "cloud";

interface OrbitBadge {
  kind: OrbitKind;
  label: string;
  tone: "ready" | "warning" | "running" | "error" | "neutral";
  angle: number;
}

interface AgentPod {
  id: string;
  name: string;
  description: string;
  status: PodStatus;
  statusText: string;
  x: number;
  y: number;
  avatar: string;
  accent: string;
  ring: string;
  vm: string;
  region: string;
  runner: "Online" | "Provisioning" | "Offline";
  provider: string;
  providerStatus: "Verified" | "Missing" | "Provisioning" | "Error";
  channels: Array<{ name: string; identity: string; status: "Connected" | "Pending" | "Error" }>;
  tasks: Array<{
    title: string;
    channel: string;
    duration: string;
    tone: "running" | "done" | "error";
  }>;
  onboarding: Array<{ label: string; status: "done" | "active" | "pending" | "error" }>;
  orbit: OrbitBadge[];
}

const pods: AgentPod[] = [
  {
    id: "sales",
    name: "Sales Agent",
    description: "Handles outbound sales, lead qualification and WhatsApp follow-ups.",
    status: "ready",
    statusText: "Ready on WhatsApp",
    x: 24,
    y: 34,
    avatar: "octo",
    accent: "#7ed7c2",
    ring: "emerald",
    vm: "octogen-sin-01",
    region: "Singapore",
    runner: "Online",
    provider: "OpenAI",
    providerStatus: "Verified",
    channels: [
      { name: "WhatsApp", identity: "+60 12-345 6789", status: "Connected" },
      { name: "Telegram", identity: "@sales_octogen", status: "Connected" },
    ],
    tasks: [
      {
        title: "Qualify Lead: Acme Sdn Bhd",
        channel: "Lead scoring + needs analysis",
        duration: "2m 14s",
        tone: "running",
      },
      {
        title: "Follow-up: Daniel Wong",
        channel: "WhatsApp message sequence",
        duration: "1m 37s",
        tone: "running",
      },
    ],
    onboarding: [
      { label: "Agent Pod Created", status: "done" },
      { label: "Hermes Runtime", status: "done" },
      { label: "AI Provider", status: "done" },
      { label: "Test Chat", status: "done" },
      { label: "Channels", status: "done" },
      { label: "Skills", status: "active" },
    ],
    orbit: [
      { kind: "provider", label: "OpenAI", tone: "ready", angle: -165 },
      { kind: "whatsapp", label: "WhatsApp", tone: "ready", angle: -90 },
      { kind: "telegram", label: "Telegram", tone: "ready", angle: -20 },
      { kind: "skill", label: "CRM", tone: "ready", angle: 70 },
      { kind: "task", label: "2 Tasks", tone: "running", angle: 150 },
    ],
  },
  {
    id: "support",
    name: "Support Agent",
    description: "Triage support tickets and hand off urgent issues to humans.",
    status: "needs_provider",
    statusText: "Needs AI Provider",
    x: 54,
    y: 28,
    avatar: "desert",
    accent: "#ffbd6e",
    ring: "amber",
    vm: "octogen-sin-02",
    region: "Singapore",
    runner: "Online",
    provider: "Not configured",
    providerStatus: "Missing",
    channels: [{ name: "Telegram", identity: "@support_octogen", status: "Pending" }],
    tasks: [],
    onboarding: [
      { label: "Agent Pod Created", status: "done" },
      { label: "Hermes Runtime", status: "done" },
      { label: "AI Provider", status: "active" },
      { label: "Test Chat", status: "pending" },
      { label: "Channels", status: "pending" },
      { label: "Skills", status: "pending" },
    ],
    orbit: [
      { kind: "provider", label: "Provider", tone: "warning", angle: -90 },
      { kind: "telegram", label: "Telegram", tone: "neutral", angle: 30 },
      { kind: "logs", label: "Logs", tone: "neutral", angle: 150 },
    ],
  },
  {
    id: "growth",
    name: "Growth Agent",
    description: "Runs campaign experiments and updates CRM opportunities.",
    status: "ready",
    statusText: "WhatsApp Connected",
    x: 43,
    y: 52,
    avatar: "turtle",
    accent: "#b7e6d3",
    ring: "green",
    vm: "octogen-sin-03",
    region: "Singapore",
    runner: "Online",
    provider: "OpenRouter",
    providerStatus: "Verified",
    channels: [{ name: "WhatsApp", identity: "+60 18-230 9981", status: "Connected" }],
    tasks: [
      {
        title: "Segment dormant leads",
        channel: "CRM enrichment",
        duration: "48s",
        tone: "running",
      },
    ],
    onboarding: [
      { label: "Agent Pod Created", status: "done" },
      { label: "Hermes Runtime", status: "done" },
      { label: "AI Provider", status: "done" },
      { label: "Test Chat", status: "done" },
      { label: "Channels", status: "done" },
      { label: "Skills", status: "active" },
    ],
    orbit: [
      { kind: "whatsapp", label: "WhatsApp", tone: "ready", angle: -90 },
      { kind: "provider", label: "OpenRouter", tone: "ready", angle: -170 },
      { kind: "telegram", label: "Telegram", tone: "neutral", angle: 5 },
      { kind: "skill", label: "CRM", tone: "ready", angle: 120 },
    ],
  },
  {
    id: "ops",
    name: "Ops Agent",
    description: "Checks operational queues and summarizes exceptions.",
    status: "provisioning",
    statusText: "Runtime Provisioning",
    x: 79,
    y: 30,
    avatar: "bird",
    accent: "#cad8bf",
    ring: "sage",
    vm: "octogen-sin-04",
    region: "Singapore",
    runner: "Provisioning",
    provider: "Pending",
    providerStatus: "Provisioning",
    channels: [],
    tasks: [],
    onboarding: [
      { label: "Agent Pod Created", status: "done" },
      { label: "Hermes Runtime", status: "active" },
      { label: "AI Provider", status: "pending" },
      { label: "Test Chat", status: "pending" },
      { label: "Channels", status: "pending" },
      { label: "Skills", status: "pending" },
    ],
    orbit: [
      { kind: "cloud", label: "VM", tone: "running", angle: -90 },
      { kind: "provider", label: "AI", tone: "neutral", angle: 25 },
      { kind: "telegram", label: "Telegram", tone: "neutral", angle: 145 },
    ],
  },
  {
    id: "content",
    name: "Content Agent",
    description: "Drafts content ideas and receives Telegram prompts.",
    status: "ready",
    statusText: "Telegram Connected",
    x: 21,
    y: 66,
    avatar: "wolf",
    accent: "#c7b8ff",
    ring: "violet-muted",
    vm: "octogen-sin-05",
    region: "Singapore",
    runner: "Online",
    provider: "OpenAI",
    providerStatus: "Verified",
    channels: [{ name: "Telegram", identity: "@content_octogen", status: "Connected" }],
    tasks: [
      {
        title: "Draft next launch post",
        channel: "Telegram request",
        duration: "34s",
        tone: "running",
      },
    ],
    onboarding: [
      { label: "Agent Pod Created", status: "done" },
      { label: "Hermes Runtime", status: "done" },
      { label: "AI Provider", status: "done" },
      { label: "Test Chat", status: "done" },
      { label: "Channels", status: "done" },
      { label: "Skills", status: "pending" },
    ],
    orbit: [
      { kind: "telegram", label: "Telegram", tone: "ready", angle: -40 },
      { kind: "provider", label: "OpenAI", tone: "ready", angle: 155 },
      { kind: "task", label: "Drafting", tone: "running", angle: 30 },
    ],
  },
  {
    id: "finance",
    name: "Finance Agent",
    description: "Watches billing events and reconciles monthly workspaces.",
    status: "running",
    statusText: "2 Tasks Running",
    x: 53,
    y: 75,
    avatar: "lighthouse",
    accent: "#f1d592",
    ring: "gold",
    vm: "octogen-sin-06",
    region: "Singapore",
    runner: "Online",
    provider: "Gemini",
    providerStatus: "Verified",
    channels: [],
    tasks: [
      {
        title: "Reconcile workspace usage",
        channel: "Billing sync",
        duration: "8m 02s",
        tone: "running",
      },
      {
        title: "Prepare anomaly note",
        channel: "Finance report",
        duration: "3m 51s",
        tone: "running",
      },
    ],
    onboarding: [
      { label: "Agent Pod Created", status: "done" },
      { label: "Hermes Runtime", status: "done" },
      { label: "AI Provider", status: "done" },
      { label: "Test Chat", status: "done" },
      { label: "Channels", status: "pending" },
      { label: "Skills", status: "active" },
    ],
    orbit: [
      { kind: "cloud", label: "VM", tone: "ready", angle: -90 },
      { kind: "task", label: "2 Tasks", tone: "running", angle: 90 },
      { kind: "skill", label: "Billing", tone: "ready", angle: 180 },
    ],
  },
  {
    id: "infra",
    name: "Infra Agent",
    description: "Monitors VM fleet recovery and runner health.",
    status: "error",
    statusText: "Channel Error",
    x: 77,
    y: 65,
    avatar: "fox",
    accent: "#f6b1a3",
    ring: "coral",
    vm: "octogen-sin-07",
    region: "Singapore",
    runner: "Offline",
    provider: "OpenAI",
    providerStatus: "Verified",
    channels: [{ name: "Email", identity: "infra@octogen.local", status: "Error" }],
    tasks: [
      { title: "Gateway repair failed", channel: "System probe", duration: "47s", tone: "error" },
    ],
    onboarding: [
      { label: "Agent Pod Created", status: "done" },
      { label: "Hermes Runtime", status: "error" },
      { label: "AI Provider", status: "done" },
      { label: "Test Chat", status: "pending" },
      { label: "Channels", status: "error" },
      { label: "Skills", status: "pending" },
    ],
    orbit: [
      { kind: "cloud", label: "AWS", tone: "neutral", angle: -170 },
      { kind: "provider", label: "OpenAI", tone: "ready", angle: -80 },
      { kind: "logs", label: "Logs", tone: "error", angle: 30 },
      { kind: "task", label: "Repair", tone: "error", angle: 140 },
    ],
  },
];

const statusCopy: Record<PodStatus, { label: string; dot: string; text: string; ring: string }> = {
  ready: { label: "Ready", dot: "bg-[#16a06b]", text: "text-[#13724f]", ring: "border-[#dbe7e1]" },
  needs_provider: {
    label: "Needs Provider",
    dot: "bg-[#f2a92f]",
    text: "text-[#a66b10]",
    ring: "border-[#eadfca]",
  },
  provisioning: {
    label: "Provisioning",
    dot: "bg-[#d8a44a]",
    text: "text-[#9a6d24]",
    ring: "border-[#e4e2d8]",
  },
  running: {
    label: "Running",
    dot: "bg-[#2c89b8]",
    text: "text-[#286f91]",
    ring: "border-[#d8e5ea]",
  },
  error: { label: "Error", dot: "bg-[#df4e3f]", text: "text-[#a8392f]", ring: "border-[#ead8d4]" },
};

function orbitIcon(kind: OrbitKind) {
  if (kind === "provider") {
    return <Sparkles className="h-3.5 w-3.5" />;
  }
  if (kind === "whatsapp") {
    return <MessageCircle className="h-3.5 w-3.5" />;
  }
  if (kind === "telegram") {
    return <Send className="h-3.5 w-3.5" />;
  }
  if (kind === "skill") {
    return <Boxes className="h-3.5 w-3.5" />;
  }
  if (kind === "task") {
    return <Activity className="h-3.5 w-3.5" />;
  }
  if (kind === "cloud") {
    return <Cloud className="h-3.5 w-3.5" />;
  }
  return <PackageCheck className="h-3.5 w-3.5" />;
}

function abstractBackground(pod: AgentPod) {
  const visualMap: Record<string, string> = {
    octo: `radial-gradient(circle at 68% 18%, rgba(255,255,255,.92), transparent 15%), radial-gradient(circle at 32% 70%, rgba(2,88,76,.62), transparent 34%), linear-gradient(135deg, #ddf5ee 0%, #6da497 100%)`,
    desert: `radial-gradient(circle at 58% 18%, rgba(255,255,255,.92), transparent 15%), radial-gradient(circle at 18% 78%, rgba(35,51,39,.78), transparent 28%), linear-gradient(145deg, #f7c47d 0%, #677b58 100%)`,
    turtle: `radial-gradient(circle at 72% 24%, rgba(255,255,255,.88), transparent 16%), radial-gradient(circle at 24% 32%, rgba(238,255,247,.86), transparent 24%), linear-gradient(145deg, #cff3e6 0%, #74a38e 100%)`,
    bird: `radial-gradient(circle at 28% 24%, rgba(255,255,255,.92), transparent 16%), linear-gradient(145deg, #eff4e6 0%, #8ea184 100%)`,
    wolf: `radial-gradient(circle at 70% 20%, rgba(255,255,255,.88), transparent 17%), linear-gradient(145deg, #eee6ff 0%, #7768a7 100%)`,
    lighthouse: `radial-gradient(circle at 28% 22%, rgba(255,255,255,.94), transparent 16%), linear-gradient(145deg, #ffe9af 0%, #bd8d35 100%)`,
    fox: `radial-gradient(circle at 30% 22%, rgba(255,255,255,.88), transparent 17%), linear-gradient(145deg, #ffdcd4 0%, #bf6d5b 100%)`,
  };
  return visualMap[pod.avatar] || `linear-gradient(145deg, #eeeeee, ${pod.accent})`;
}

function AgentAvatarScene({ pod }: { pod: AgentPod }) {
  if (pod.avatar === "octo") {
    return (
      <>
        <div className="absolute bottom-[18%] left-[33%] h-[34%] w-[34%] rounded-t-[999px] bg-black/78" />
        <div className="absolute left-[39%] top-[27%] h-[22%] w-[22%] rounded-full bg-black/82" />
        <div className="absolute bottom-[27%] left-[24%] h-[18%] w-[14%] rounded-full border border-white/55" />
        <div className="absolute right-[22%] top-[31%] h-1.5 w-1.5 rounded-full bg-white/80 shadow-[10px_8px_0_rgba(255,255,255,0.52),-4px_18px_0_rgba(255,255,255,0.42)]" />
      </>
    );
  }
  if (pod.avatar === "desert") {
    return (
      <>
        <div className="absolute left-[29%] top-[26%] h-[38%] w-[42%] rounded-full border-[5px] border-black/58 border-b-transparent" />
        <div className="absolute left-[36%] top-[36%] h-[22%] w-[22%] rounded-full bg-black/22" />
        <div className="absolute right-[23%] top-[48%] h-[20%] w-[12%] rounded-full bg-black/62" />
        <div className="absolute bottom-[22%] left-[30%] h-[12%] w-[42%] rounded-full bg-white/35" />
      </>
    );
  }
  if (pod.avatar === "turtle") {
    return (
      <>
        <div className="absolute left-[26%] top-[24%] h-[40%] w-[22%] rotate-[-28deg] rounded-full bg-white/62" />
        <div className="absolute left-[44%] top-[26%] h-[44%] w-[24%] rotate-[24deg] rounded-full bg-[#176f55]/40" />
        <div className="absolute left-[34%] top-[44%] h-[30%] w-[20%] rotate-[50deg] rounded-full bg-white/42" />
        <div className="absolute bottom-[24%] right-[24%] h-[15%] w-[15%] rounded-full bg-black/28" />
      </>
    );
  }
  if (pod.avatar === "bird") {
    return (
      <>
        <div className="absolute left-[22%] top-[34%] h-[24%] w-[48%] -rotate-12 rounded-full bg-white/66" />
        <div className="absolute right-[25%] top-[28%] h-[42%] w-[18%] rotate-[36deg] rounded-full bg-black/48" />
        <div className="absolute left-[31%] top-[39%] h-[18%] w-[40%] rotate-[24deg] rounded-full bg-[#334136]/48" />
        <div className="absolute left-[26%] bottom-[28%] h-[10%] w-[42%] rounded-full bg-black/20" />
        <div className="absolute right-[26%] bottom-[36%] h-2 w-2 rounded-full bg-white/86" />
      </>
    );
  }
  if (pod.avatar === "wolf") {
    return (
      <>
        <div className="absolute left-[25%] top-[27%] h-[34%] w-[42%] rotate-[-8deg] rounded-[18px] bg-white/58 shadow-[0_10px_24px_rgba(0,0,0,0.12)]" />
        <div className="absolute right-[23%] top-[36%] h-[34%] w-[36%] rotate-[10deg] rounded-[16px] bg-black/46 shadow-[0_10px_24px_rgba(0,0,0,0.12)]" />
        <div className="absolute left-[34%] top-[39%] h-1.5 w-[28%] rounded-full bg-black/24" />
        <div className="absolute left-[34%] top-[48%] h-1.5 w-[20%] rounded-full bg-black/16" />
      </>
    );
  }
  if (pod.avatar === "lighthouse") {
    return (
      <>
        <div className="absolute bottom-[22%] left-[31%] h-[42%] w-[12%] rounded-full bg-white/64" />
        <div className="absolute bottom-[22%] left-[48%] h-[54%] w-[12%] rounded-full bg-black/34" />
        <div className="absolute bottom-[22%] right-[27%] h-[31%] w-[12%] rounded-full bg-white/48" />
        <div className="absolute left-[28%] top-[27%] h-[18%] w-[44%] rounded-full border border-white/58" />
      </>
    );
  }
  return (
    <>
      <div className="absolute left-[28%] top-[30%] h-3 w-3 rounded-full bg-black/52" />
      <div className="absolute right-[28%] top-[30%] h-3 w-3 rounded-full bg-white/72" />
      <div className="absolute bottom-[30%] left-[38%] h-3 w-3 rounded-full bg-white/62" />
      <div className="absolute bottom-[34%] right-[30%] h-2.5 w-2.5 rounded-full bg-black/36" />
      <div className="absolute left-[34%] top-[38%] h-px w-[34%] rotate-[18deg] bg-black/26" />
      <div className="absolute left-[34%] bottom-[38%] h-px w-[28%] -rotate-[28deg] bg-black/22" />
      <div className="absolute right-[30%] top-[42%] h-px w-[20%] rotate-[62deg] bg-white/38" />
      <div className="absolute inset-[26%] rounded-[20px] border border-white/42" />
    </>
  );
}

function AgentAvatar({ pod, sizeClass }: { pod: AgentPod; sizeClass: string }) {
  return (
    <div
      className={`relative grid ${sizeClass} place-items-center overflow-hidden rounded-full border border-white/80 shadow-[0_22px_58px_rgba(15,15,15,0.12)] ring-1 ring-black/[0.025]`}
      style={{ background: abstractBackground(pod) }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_35%_22%,rgba(255,255,255,0.6),transparent_28%),linear-gradient(180deg,transparent,rgba(0,0,0,0.08))]" />
      <div className="absolute inset-[10px] rounded-full border border-white/28" />
      <AgentAvatarScene pod={pod} />
    </div>
  );
}

function AgentOrb({
  pod,
  selected,
  dimmed,
  onSelect,
}: {
  pod: AgentPod;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
}) {
  const status = statusCopy[pod.status];
  const size =
    pod.id === "growth"
      ? "h-[124px] w-[124px]"
      : pod.id === "support" || pod.id === "finance"
        ? "h-[112px] w-[112px]"
        : "h-[104px] w-[104px]";
  return (
    <button
      onClick={onSelect}
      className={`group absolute -translate-x-1/2 -translate-y-1/2 text-left outline-none transition-all duration-700 ease-out ${selected ? "z-40 scale-110" : "z-20 hover:-translate-y-[calc(50%+6px)] hover:scale-[1.04]"} ${dimmed ? "opacity-25 grayscale" : "opacity-100"}`}
      style={{ left: `${pod.x}%`, top: `${pod.y}%` }}
      aria-label={`${pod.name} - ${pod.statusText}`}
    >
      <div className="relative grid place-items-center">
        <div
          className={`absolute rounded-full border ${status.ring} bg-white/25 blur-[1px] ${selected ? "inset-[-26px]" : "inset-[-18px]"}`}
        />
        <div
          className={`absolute rounded-full border border-white/70 ${selected ? "inset-[-12px]" : "inset-[-8px]"}`}
        />
        <AgentAvatar pod={pod} sizeClass={size} />
        {pod.orbit.slice(0, 3).map((badge, index) => {
          const positions = ["-right-2 top-3", "-left-3 top-7", "right-3 -bottom-2"];
          return (
            <span
              key={`${pod.id}-${badge.kind}-${badge.angle}`}
              className={`absolute ${positions[index]} grid h-8 w-8 place-items-center rounded-full border border-white/80 bg-white/82 text-black/62 shadow-[0_10px_24px_rgba(0,0,0,0.09)] backdrop-blur-xl`}
              title={badge.label}
            >
              {orbitIcon(badge.kind)}
            </span>
          );
        })}
        <span
          className={`absolute bottom-2 h-3 w-3 rounded-full ${status.dot} shadow-[0_0_0_5px_rgba(255,255,255,0.92)]`}
        />
      </div>
      <div className="mt-3 text-center">
        <p className="text-[16px] font-semibold tracking-[-0.045em] text-black">{pod.name}</p>
        <p className={`mt-1 text-[12px] font-medium ${status.text}`}>{pod.statusText}</p>
      </div>
    </button>
  );
}

function Rail() {
  const items = [Map, Grid3X3, MessageCircle, Layers3, Boxes, PackageCheck, Settings];
  return (
    <aside className="flex h-full w-[62px] shrink-0 flex-col items-center justify-between rounded-full border border-black/[0.06] bg-white/55 px-2 py-3 shadow-[0_20px_70px_rgba(0,0,0,0.08)] backdrop-blur-2xl">
      <div className="space-y-2">
        {items.map((Icon, index) => (
          <button
            key={index}
            className={`grid h-11 w-11 place-items-center rounded-full transition ${index === 0 ? "bg-black text-white shadow-[0_12px_28px_rgba(0,0,0,0.18)]" : "text-black/45 hover:bg-white hover:text-black"}`}
          >
            <Icon className="h-4.5 w-4.5" />
          </button>
        ))}
      </div>
      <div className="grid h-10 w-10 place-items-center rounded-full bg-white text-black/45 shadow-[0_8px_18px_rgba(0,0,0,0.06)]">
        <span className="text-sm font-semibold">?</span>
      </div>
    </aside>
  );
}

function AgentFloatCard({ pod, onClose }: { pod: AgentPod; onClose: () => void }) {
  const done = pod.onboarding.filter((step) => step.status === "done").length;
  const progress = Math.round((done / pod.onboarding.length) * 100);
  const status = statusCopy[pod.status];
  const nextAction =
    pod.status === "ready"
      ? "Open Playground"
      : pod.status === "needs_provider"
        ? "Install Provider"
        : pod.status === "provisioning"
          ? "View Queue"
          : pod.status === "error"
            ? "Retry Runtime"
            : "Review Tasks";
  const popoverLeft = pod.x > 62 ? `calc(${pod.x}% - 420px)` : `calc(${pod.x}% + 112px)`;
  const popoverTop =
    pod.y < 34 ? "112px" : pod.y > 66 ? "calc(100% - 530px)" : `calc(${pod.y}% - 210px)`;

  return (
    <aside
      className="absolute z-50 flex max-h-[min(560px,calc(100%-120px))] w-[390px] max-w-[calc(100%-112px)] flex-col overflow-hidden rounded-[34px] border border-black/[0.06] bg-white/76 p-5 shadow-[0_34px_110px_rgba(0,0,0,0.16)] backdrop-blur-3xl"
      style={{ left: popoverLeft, top: popoverTop }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <AgentAvatar pod={pod} sizeClass="h-16 w-16" />
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-black/38">
              Agent Pod
            </p>
            <h2 className="text-3xl font-semibold tracking-[-0.07em] text-black">{pod.name}</h2>
            <p className="mt-1 text-sm text-black/48">{pod.vm}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/[0.045] text-black/45 transition hover:bg-black hover:text-white"
          aria-label="Close agent details"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-6 rounded-[26px] bg-black/[0.035] p-4">
        <div className="flex items-start gap-3">
          {pod.status === "ready" ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-[#16a06b]" />
          ) : pod.status === "error" ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 text-[#df4e3f]" />
          ) : (
            <CircleDot className="mt-0.5 h-5 w-5 text-[#d8a44a]" />
          )}
          <div>
            <div className={`text-xs font-bold uppercase tracking-[0.18em] ${status.text}`}>
              {status.label}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-black/58">{pod.description}</p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[96px_1fr] gap-4 rounded-[26px] bg-black/[0.035] p-4">
        <div className="relative grid h-24 w-24 place-items-center rounded-full bg-white">
          <div
            className="absolute inset-0 rounded-full"
            style={{ background: `conic-gradient(#111 ${progress}%, #e5e5e0 ${progress}% 100%)` }}
          />
          <div className="relative grid h-[72px] w-[72px] place-items-center rounded-full bg-white text-2xl font-semibold tracking-[-0.05em] text-black">
            {progress}%
          </div>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-black/38">
            Onboarding
          </p>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
            {pod.onboarding.map((step) => (
              <div key={step.label} className="flex items-center gap-2 text-xs text-black/52">
                <span
                  className={`h-2 w-2 rounded-full ${
                    step.status === "done"
                      ? "bg-[#16a06b]"
                      : step.status === "active"
                        ? "bg-[#f2a92f]"
                        : step.status === "error"
                          ? "bg-[#df4e3f]"
                          : "bg-black/16"
                  }`}
                />
                {step.label}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 overflow-auto pr-1">
        <Section title="Runtime">
          <StatusRow
            icon={<Sparkles className="h-4 w-4" />}
            label="Hermes"
            value={pod.status === "provisioning" ? "Provisioning" : "Ready"}
            tone={
              pod.status === "error" ? "error" : pod.status === "provisioning" ? "warning" : "ready"
            }
          />
        </Section>
        <Section title="Infrastructure">
          <StatusRow
            icon={<Cpu className="h-4 w-4" />}
            label="VM Body"
            value={pod.vm}
            tone="neutral"
          />
          <StatusRow
            icon={<Wifi className="h-4 w-4" />}
            label="Runner"
            value={pod.runner}
            tone={
              pod.runner === "Online" ? "ready" : pod.runner === "Offline" ? "error" : "warning"
            }
          />
        </Section>
        <Section title="Channels" badge={String(pod.channels.length)}>
          {pod.channels.length > 0 ? (
            pod.channels.map((channel) => (
              <StatusRow
                key={`${channel.name}-${channel.identity}`}
                icon={
                  channel.name === "Telegram" ? (
                    <Send className="h-4 w-4" />
                  ) : (
                    <MessageCircle className="h-4 w-4" />
                  )
                }
                label={channel.name}
                value={channel.identity}
                tone={
                  channel.status === "Connected"
                    ? "ready"
                    : channel.status === "Error"
                      ? "error"
                      : "warning"
                }
              />
            ))
          ) : (
            <p className="px-1 py-2 text-sm text-black/42">No channels connected yet.</p>
          )}
        </Section>
      </div>

      <div className="mt-4 flex gap-2">
        <button className="flex-1 rounded-full bg-black px-4 py-3 text-sm font-semibold text-white shadow-[0_16px_34px_rgba(0,0,0,0.18)]">
          {nextAction}
        </button>
        <button className="grid h-12 w-12 place-items-center rounded-full bg-black/[0.055] text-black/58">
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </div>
    </aside>
  );
}

function Section({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[22px] bg-black/[0.028] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-black/34">{title}</p>
        {badge ? (
          <span className="rounded-full bg-white px-2 py-0.5 text-xs text-black/52">{badge}</span>
        ) : null}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function StatusRow({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "ready" | "warning" | "error" | "neutral";
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl bg-white/70 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-black">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-black/[0.045] text-black/54">
          {icon}
        </span>
        <span className="font-medium">{label}</span>
      </div>
      <span
        className={`max-w-[150px] truncate text-right text-xs font-semibold ${
          tone === "ready"
            ? "text-[#168457]"
            : tone === "warning"
              ? "text-[#b67508]"
              : tone === "error"
                ? "text-[#bd4d35]"
                : "text-black/44"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export default function OctogenPrototypePage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const filteredPods = useMemo(
    () =>
      viewMode === "setup"
        ? pods.filter((pod) => pod.status !== "ready" && pod.status !== "running")
        : pods,
    [viewMode],
  );
  const selectedPod = useMemo(
    () => (selectedId ? filteredPods.find((pod) => pod.id === selectedId) || null : null),
    [filteredPods, selectedId],
  );

  return (
    <main className="octogen-modern h-screen overflow-hidden text-black">
      <style jsx global>{`
        .octogen-modern {
          background:
            radial-gradient(circle at 44% 34%, rgba(255, 255, 255, 1), transparent 28%),
            radial-gradient(circle at 82% 17%, rgba(226, 238, 238, 0.8), transparent 26%),
            linear-gradient(180deg, #fbfbf8 0%, #f4f5f1 100%);
          font-family: "Helvetica Neue", "Avenir Next", ui-sans-serif, system-ui, sans-serif;
          font-feature-settings:
            "liga" 1,
            "kern" 1;
        }
        @keyframes quietDrift {
          0%,
          100% {
            transform: translate3d(0, 0, 0) rotate(0deg);
          }
          50% {
            transform: translate3d(0, -9px, 0) rotate(1.2deg);
          }
        }
        @keyframes lineBreath {
          0%,
          100% {
            opacity: 0.13;
          }
          50% {
            opacity: 0.28;
          }
        }
        .modern-canvas {
          background-image:
            radial-gradient(circle, rgba(0, 0, 0, 0.045) 1px, transparent 1.2px),
            linear-gradient(120deg, rgba(255, 255, 255, 0.82), rgba(241, 243, 239, 0.78));
          background-size:
            18px 18px,
            auto;
        }
        .modern-line {
          animation: lineBreath 4.8s ease-in-out infinite;
          stroke-dasharray: 2 10;
        }
        .drift-1 {
          animation: quietDrift 8s ease-in-out infinite;
        }
        .drift-2 {
          animation: quietDrift 9s ease-in-out infinite reverse;
        }
      `}</style>

      <div className="relative h-screen overflow-hidden">
        <section className="modern-canvas absolute inset-[14px] overflow-hidden rounded-[34px] border border-black/[0.055] shadow-[0_28px_120px_rgba(0,0,0,0.08)]">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,transparent_0%,transparent_62%,rgba(0,0,0,0.035)_100%)]" />
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 1000 700"
            preserveAspectRatio="none"
          >
            <path
              className="modern-line"
              d="M210 245 C 330 170, 385 400, 515 350 S 690 170, 790 220"
              fill="none"
              stroke="#111"
              strokeWidth="1"
            />
            <path
              className="modern-line"
              d="M210 475 C 335 410, 420 545, 520 505 S 660 415, 770 450"
              fill="none"
              stroke="#111"
              strokeWidth="1"
            />
            <path
              className="modern-line"
              d="M440 380 C 520 430, 605 390, 770 450"
              fill="none"
              stroke="#111"
              strokeWidth="1"
            />
          </svg>

          <div className="absolute left-10 top-8 z-50 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-black text-white shadow-[0_16px_36px_rgba(0,0,0,0.18)]">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[19px] font-semibold uppercase tracking-[0.34em] text-black">
                Octogen
              </p>
              <p className="text-[10px] font-semibold uppercase tracking-[0.42em] text-black/36">
                Console
              </p>
            </div>
          </div>

          <header className="absolute left-1/2 top-7 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-black/[0.055] bg-white/70 px-3 py-2 shadow-[0_18px_60px_rgba(0,0,0,0.08)] backdrop-blur-2xl">
            <button className="flex h-10 items-center gap-3 rounded-full bg-white px-3 text-sm font-semibold text-black shadow-[0_8px_24px_rgba(0,0,0,0.05)]">
              <Map className="h-4 w-4" /> Octogen HQ{" "}
              <ChevronDown className="h-3.5 w-3.5 text-black/38" />
            </button>
            <div className="hidden h-10 items-center gap-2 rounded-full px-3 text-sm text-black/40 lg:flex">
              <Command className="h-3.5 w-3.5" /> Search agents, tools, actions
            </div>
          </header>

          <div className="absolute right-9 top-8 z-50 flex items-center gap-2">
            <button className="flex h-12 items-center gap-2 rounded-full bg-black px-5 text-sm font-semibold text-white shadow-[0_18px_42px_rgba(0,0,0,0.18)]">
              <Plus className="h-4 w-4" /> Create Agent
            </button>
            <button className="grid h-12 w-12 place-items-center rounded-full bg-white/76 text-black shadow-[0_14px_40px_rgba(0,0,0,0.08)] backdrop-blur-2xl">
              <Bell className="h-4.5 w-4.5" />
            </button>
            <button className="grid h-12 w-12 place-items-center rounded-full bg-white/76 text-sm font-semibold text-black shadow-[0_14px_40px_rgba(0,0,0,0.08)] backdrop-blur-2xl">
              A
            </button>
          </div>

          <div className="absolute left-[104px] top-[112px] z-40 flex gap-1 rounded-full bg-white/62 p-1 shadow-[0_14px_45px_rgba(0,0,0,0.075)] backdrop-blur-2xl">
            {(
              [
                ["live", "Live"],
                ["status", "Status"],
                ["setup", "Setup"],
              ] as Array<[ViewMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`rounded-full px-4 py-2 text-xs font-semibold transition ${viewMode === mode ? "bg-black text-white" : "text-black/46 hover:bg-white hover:text-black"}`}
              >
                {label}
              </button>
            ))}
          </div>

          {viewMode === "status" ? (
            <div className="pointer-events-none absolute inset-0 z-0">
              <div className="absolute left-[11%] top-[21%] h-[28%] w-[25%] rounded-full bg-[#cde9df]/28 blur-3xl" />
              <div className="absolute left-[45%] top-[14%] h-[29%] w-[28%] rounded-full bg-[#f3d7ad]/30 blur-3xl" />
              <div className="absolute left-[66%] top-[50%] h-[30%] w-[25%] rounded-full bg-[#f2c3ba]/26 blur-3xl" />
            </div>
          ) : null}

          <div className="absolute bottom-6 left-6 top-[112px] z-50">
            <Rail />
          </div>

          {filteredPods.map((pod) => (
            <AgentOrb
              key={pod.id}
              pod={pod}
              selected={selectedPod?.id === pod.id}
              dimmed={viewMode === "setup" && pod.status === "ready"}
              onSelect={() => setSelectedId(pod.id)}
            />
          ))}

          {selectedPod ? (
            <AgentFloatCard pod={selectedPod} onClose={() => setSelectedId(null)} />
          ) : null}

          <div className="absolute bottom-8 left-[104px] z-40 flex items-end gap-3">
            <div className="h-[94px] w-[142px] rounded-[28px] bg-white/58 p-3 shadow-[0_18px_55px_rgba(0,0,0,0.08)] backdrop-blur-2xl">
              <div className="relative h-full rounded-[20px] border border-dashed border-black/12 bg-black/[0.025]">
                {pods.map((pod) => (
                  <button
                    key={`mini-${pod.id}`}
                    onClick={() => setSelectedId(pod.id)}
                    className={`absolute h-2.5 w-2.5 rounded-full ${statusCopy[pod.status].dot} ${selectedPod?.id === pod.id ? "ring-4 ring-black/10" : ""}`}
                    style={{ left: `${pod.x}%`, top: `${pod.y}%` }}
                  />
                ))}
              </div>
            </div>
            <div className="grid overflow-hidden rounded-full bg-white/62 shadow-[0_18px_55px_rgba(0,0,0,0.08)] backdrop-blur-2xl">
              <button className="grid h-10 w-10 place-items-center border-b border-black/[0.05] text-black/45">
                <ZoomIn className="h-4 w-4" />
              </button>
              <button className="grid h-10 w-10 place-items-center border-b border-black/[0.05] text-black/45">
                <ZoomOut className="h-4 w-4" />
              </button>
              <button className="grid h-10 w-10 place-items-center text-black/45">
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
