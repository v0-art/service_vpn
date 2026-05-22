export interface Node {
  id: number;
  ip: string;
  role: 'master' | 'ingress' | 'egress';
  billing_date: string;
  status: 'active' | 'offline';
  has_ssh_key: boolean;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
