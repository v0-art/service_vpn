export interface Node {
  id: number;
  ip: string;
  role: 'master' | 'ingress' | 'egress';
  billing_date: string;
  status: 'active' | 'offline';
  has_ssh_key: boolean;
  ssh_port: number;
}

export interface NodeUpdatePayload {
  ip?: string;
  role?: 'master' | 'ingress' | 'egress';
  billing_date?: string;
  ssh_key?: string;
  ssh_port?: number;
  status?: 'active' | 'offline';
}

export interface NodeConnectionStatus {
  id: number;
  ip: string;
  role: 'master' | 'ingress' | 'egress';
  status: string;
  ssh_port: number;
  checked: boolean;
  connected: boolean;
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
  nodes: NodeConnectionStatus[];
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
