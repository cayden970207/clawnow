# Octogen Console Phase 1 (Hetzner, Dedicated VM, Trusted Proxy)

## 目标

- 基础设施固定为 Hetzner（Singapore）
- 每个 workspace 可创建 managed VM
- 24/7 常驻 VM，不做共享宿主机分租
- Auth 复用 CreateNow（Bearer token），Gateway 走 `trusted-proxy`
- 一期 UI 先对接官方 Control UI（新标签页），noVNC 按需 30 分钟

## 控制面设计

- `src/app/api/octogen/vms/*` 负责 VM 生命周期和访问会话编排
- `src/lib/services/octogen.service.ts` 负责业务策略（workspace access、会话签名、审计）
- `src/lib/services/octogen-hetzner.service.ts` 负责云厂商 API（仅 Hetzner）

这一层与前端 UI 解耦，后续可以直接替换前端而不改 VM 架构。

## 数据模型

- `octogen_vms`: workspace-owned VM 主表（含 Hetzner server_id、状态、IP、入口 URL）
- `octogen_vm_events`: 生命周期审计事件
- `octogen_vm_access_sessions`: trusted-proxy 的短期访问会话（Control UI / noVNC）

数据库以 `workspace_id` 作为 tenant boundary。`created_by_user_id` / `actor_user_id` 只记录操作者。

## 会话与安全

- Control UI 和 noVNC 不直接暴露长期凭证
- 每次访问由控制面签发短期 token（HMAC）
- token hash 落库审计，支持后续做一次性消费和吊销

## 多租户访问链路（Phase 1）

- 默认使用 `OCTOGEN_VM_GATEWAY_TEMPLATE`（`http://{{IPV4}}:18790`）为每个 VM 生成独立 gateway URL
- `launch-control-ui` 会从 VM 记录里的 `control_ui_url` 发放访问地址
- 如需统一入口，也支持设置 `OCTOGEN_GATEWAY_BASE_URL` + `OCTOGEN_CONTROL_UI_BASE_URL` / `OCTOGEN_NOVNC_BASE_URL` 走 shared-proxy

## VM 初始化

- 默认 cloud-init 会自动执行 `scripts/octogen-vm-bootstrap.sh`（gateway + trusted-proxy systemd 常驻）
- 支持通过 `OCTOGEN_OPENCLAW_BOOTSTRAP_COMMAND` 在 VM 创建后自动执行 OpenClaw 启动命令
- 如需完全自定义初始化，使用 `OCTOGEN_HETZNER_CLOUD_INIT` 覆盖默认 cloud-init

## 二期演进

1. 保持 `Octogen Console API` 不变，替换 UI 为自研控制台
2. 引入更细粒度 RBAC（org/team 级）
3. 在反向代理层增加审计回调（会话消费、命令轨迹）
