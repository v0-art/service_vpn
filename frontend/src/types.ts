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
  billing_date: string;
  status: NodeStatus;
  has_ssh_key: boolean;
  ssh_port: number;
  inbound_tag: InboundTag;
  inbound_port: number;
  group_sni: string;
  fingerprint: string;
  marzban_node_id?: number | null;
  marzban_node_status?: string | null;
  marzban_last_error?: string | null;
  provision_status?: string | null;
}

export interface NodeCreatePayload {
  name: string;
  ip: string;
  role: NodeRole;
  billing_date: string;
  ssh_port: number;
  ssh_key?: string;
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
