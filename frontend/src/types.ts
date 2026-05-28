export type NodeRole = 'master' | 'ingress' | 'egress';
export type NodeStatus = 'active' | 'offline';

export type InboundTag =
  | 'IN-RU-DIRECT'
  | 'IN-EU-DIRECT'
  | 'IN-TRANSIT-GB'
  | 'IN-TRANSIT-NO'
  | 'IN-EU-TRANSIT-RECV'
  | 'IN-EU-DIRECT-WARP';

export interface Node {
  id: number;
  name: string;
  ip: string;
  role: NodeRole;
  roles?: string[];
  billing_date: string;
  status: NodeStatus;
  has_ssh_key: boolean;
  has_ssh_password?: boolean;
  has_credentials?: boolean;
  credential_status?: string;
  ssh_username?: string;
  ssh_port: number;
  inbound_tag: InboundTag;
  inbound_port: number;
  group_sni: string;
  fingerprint: string;
  inbounds?: NodeInbound[];
  marzban_node_id?: number | null;
  marzban_node_name?: string | null;
  marzban_node_port?: number | null;
  marzban_node_api_port?: number | null;
  marzban_usage_coefficient?: number | null;
  last_marzban_sync?: number | null;
  marzban_node_status?: string | null;
  marzban_last_error?: string | null;
  provision_status?: string | null;
}

export interface NodeInbound {
  id: number;
  node_id: number;
  inbound_tag: string;
  remark: string;
  address: string;
  port?: number | null;
  sni?: string | null;
  host?: string | null;
  fingerprint?: string | null;
  security?: string | null;
  alpn?: string | null;
  is_disabled: boolean;
  original_remark?: string | null;
  updated_at?: number | null;
}

export interface NodeCreatePayload {
  name: string;
  ip: string;
  role: NodeRole;
  billing_date: string;
  ssh_port: number;
  ssh_username?: string;
  ssh_key?: string;
  ssh_password?: string;
  inbound_tag: InboundTag;
  inbound_port: number;
  group_sni: string;
  fingerprint: string;
  add_mode: 'existing' | 'new';
}

export interface NodeUpdatePayload {
  name?: string;
  ip?: string;
  role?: NodeRole;
  billing_date?: string;
  ssh_key?: string;
  ssh_password?: string;
  ssh_username?: string;
  ssh_port?: number;
  status?: NodeStatus;
  inbound_tag?: InboundTag;
  inbound_port?: number;
  group_sni?: string;
  fingerprint?: string;
  reconnect_marzban?: boolean;
}

export interface NodeConnectionStatus {
  id: number;
  name?: string;
  ip: string;
  role: NodeRole;
  status: string;
  ssh_port: number;
  credential_status?: string;
  inbound_tag?: string;
  checked: boolean;
  connected: boolean;
  provision_status?: string | null;
  marzban_node_status?: string | null;
  marzban_last_error?: string | null;
  error?: string | null;
}

export interface SystemOverview {
  timestamp: number;
  nodes_total: number;
  nodes_active: number;
  ssh_reachable: number;
  ssh_unreachable: number;
  marzban_connected: boolean;
  marzban_users_count: number;
  marzban_error?: string | null;
  marzban_error_code?: string | null;
  marzban_http_status?: number | null;
  nodes: NodeConnectionStatus[];
}

export interface MarzbanConnection {
  connected: boolean;
  users_count: number;
  http_status?: number | null;
  error_code?: string | null;
  error?: string | null;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface MarzbanImportResult {
  status: string;
  message?: string;
  imported: number;
  updated: number;
  inbounds: number;
  unmatched_hosts: Array<{ inbound_tag: string; address: string; remark?: string | null }>;
}

export interface MarzbanNode {
  id?: number | string | null;
  name?: string | null;
  remark?: string | null;
  address?: string | null;
  ip?: string | null;
  host?: string | null;
  status?: string | null;
  port?: number | string | null;
  api_port?: number | string | null;
  usage_coefficient?: number | string | null;
  [key: string]: unknown;
}

export interface MarzbanHost {
  remark?: string | null;
  address?: string | null;
  port?: number | string | null;
  sni?: string | null;
  host?: string | null;
  fingerprint?: string | null;
  security?: string | null;
  is_disabled?: boolean | null;
  [key: string]: unknown;
}

export interface MarzbanInventorySnapshot {
  nodes: MarzbanNode[];
  hosts: Record<string, unknown>;
}

export interface MarzbanNodeImportPayload {
  marzban_node_id?: number;
  address?: string;
  billing_date?: string;
  ssh_username?: string;
  ssh_key?: string;
  ssh_password?: string;
  ssh_port?: number;
}

export interface MarzbanNodeImportResult {
  status: string;
  message?: string;
  node_id?: number;
  imported?: boolean;
  updated?: boolean;
  inbounds?: number;
  roles?: string[];
}

export interface NodeCredentialsPayload {
  ssh_username?: string;
  ssh_key?: string;
  ssh_password?: string;
  ssh_port?: number;
}
