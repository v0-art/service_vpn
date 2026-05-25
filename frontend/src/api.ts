import {
  ApiResponse,
  MarzbanConnection,
  Node,
  NodeCreatePayload,
  NodeUpdatePayload,
  SystemOverview,
} from './types';

export const getInitData = (): string => {
  // @ts-ignore
  if (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) {
    // @ts-ignore
    return window.Telegram.WebApp.initData || '';
  }
  return '';
};

export const isTelegramContext = (): boolean => {
  // @ts-ignore
  return Boolean(typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp);
};

const API_BASE = '/api';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveInitData(): Promise<string> {
  let initData = getInitData();
  if (initData) {
    return initData;
  }

  for (let i = 0; i < 12; i += 1) {
    await sleep(100);
    initData = getInitData();
    if (initData) {
      return initData;
    }
  }

  return '';
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const initData = await resolveInitData();
  if (!initData) {
    throw new Error('Откройте панель через Telegram-бота: не найден Telegram initData.');
  }

  const headers: Record<string, string> = {
    'X-Telegram-Init-Data': initData,
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    if (isJson) {
      try {
        const payload = await res.json();
        detail = payload?.detail || payload?.message || detail;
      } catch {
        // ignore parse error
      }
    }
    throw new Error(detail);
  }

  if (!isJson) {
    throw new Error('Сервер вернул не-JSON ответ.');
  }

  return (await res.json()) as T;
}

export async function fetchNodes(): Promise<Node[]> {
  try {
    return await apiRequest<Node[]>('/nodes');
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function addNode(payload: NodeCreatePayload): Promise<ApiResponse<{ message?: string; status?: string; node_id?: number }>> {
  try {
    const data = await apiRequest<{ status: string; message?: string; node_id?: number }>('/nodes', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const statusValue = data?.status || 'success';
    if (statusValue === 'partial') {
      return {
        success: false,
        error: data?.message || 'Сервер добавлен частично: провижининг завершился с ошибкой.',
        data: { message: data?.message, status: statusValue, node_id: data?.node_id },
      };
    }

    return {
      success: true,
      data: { message: data?.message, status: statusValue, node_id: data?.node_id },
    };
  } catch (error) {
    console.error(error);
    return { success: false, error: String(error) };
  }
}

export async function updateNode(nodeId: number, payload: NodeUpdatePayload): Promise<ApiResponse<{ message?: string; status?: string }>> {
  try {
    const data = await apiRequest<{ status: string; message?: string }>(`/nodes/${nodeId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    if (data?.status === 'partial') {
      return { success: false, error: data?.message || 'Сервер обновлен частично.', data };
    }

    return { success: true, data };
  } catch (error) {
    console.error(error);
    return { success: false, error: String(error) };
  }
}

export async function deleteNode(nodeId: number, cleanupRemote = true): Promise<ApiResponse<{ message?: string }>> {
  try {
    const data = await apiRequest<{ message?: string }>(`/nodes/${nodeId}`, {
      method: 'DELETE',
      body: JSON.stringify({ cleanup_remote: cleanupRemote }),
    });
    return { success: true, data };
  } catch (error) {
    console.error(error);
    return { success: false, error: String(error) };
  }
}

export async function fetchSystemOverview(): Promise<SystemOverview> {
  try {
    return await apiRequest<SystemOverview>('/status/overview');
  } catch (error) {
    console.error(error);
    return {
      timestamp: Math.floor(Date.now() / 1000),
      nodes_total: 0,
      nodes_active: 0,
      ssh_reachable: 0,
      ssh_unreachable: 0,
      marzban_connected: false,
      marzban_users_count: 0,
      marzban_error: String(error),
      marzban_error_code: 'network',
      marzban_http_status: null,
      nodes: [],
    };
  }
}

export async function fetchMarzbanConnection(): Promise<MarzbanConnection> {
  try {
    return await apiRequest<MarzbanConnection>('/marzban/connection');
  } catch (error) {
    console.error(error);
    return {
      connected: false,
      users_count: 0,
      error_code: 'network',
      error: String(error),
      http_status: null,
    };
  }
}

export async function reconnectMarzban(): Promise<ApiResponse<{ message?: string; connection?: MarzbanConnection }>> {
  try {
    const data = await apiRequest<{ status: string; message?: string; connection?: MarzbanConnection }>('/marzban/reconnect', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    if (data?.status === 'error') {
      return { success: false, error: data?.message || 'Не удалось переподключиться к Marzban.' };
    }

    return { success: true, data };
  } catch (error) {
    console.error(error);
    return { success: false, error: String(error) };
  }
}

export async function applyHAProxyConfig(ip: string, config: string): Promise<ApiResponse<null>> {
  try {
    await apiRequest('/haproxy/apply', {
      method: 'POST',
      body: JSON.stringify({ ip, config_content: config }),
    });
    return { success: true };
  } catch (error) {
    console.error(error);
    return { success: false, error: String(error) };
  }
}

export async function fetchMarzbanStats(): Promise<any> {
  try {
    return await apiRequest('/marzban/stats');
  } catch (error) {
    console.error(error);
    return {
      anomalies: [],
      top_users: [],
    };
  }
}

export async function fetchSecurityAudit(): Promise<any> {
  try {
    return await apiRequest('/security/audit');
  } catch (error) {
    console.error(error);
    return {
      banned_ips: [],
      ssh_logins: [],
    };
  }
}

export async function executeSysinfo(ip: string): Promise<string[]> {
  try {
    const data = await apiRequest<{ logs: string[] }>('/sysinfo', {
      method: 'POST',
      body: JSON.stringify({ ip }),
    });
    return data.logs;
  } catch (error) {
    console.error(error);
    return [`[ERROR] Не удалось получить sysinfo для ${ip}`, String(error)];
  }
}
