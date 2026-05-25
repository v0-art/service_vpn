import { Node, ApiResponse, SystemOverview, NodeUpdatePayload } from "./types";

export const getInitData = (): string => {
    // @ts-ignore
    if (typeof window !== "undefined" && window.Telegram && window.Telegram.WebApp) {
        // @ts-ignore
        return window.Telegram.WebApp.initData || "";
    }
    return "";
};

export const isTelegramContext = (): boolean => Boolean(getInitData());

const API_BASE = "/api";

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const initData = getInitData();
    if (!initData) {
        throw new Error("Откройте панель через Telegram-бота: не найден Telegram initData.");
    }

    const headers: Record<string, string> = {
        "X-Telegram-Init-Data": initData,
        ...(init?.headers as Record<string, string> | undefined),
    };
    if (init?.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");

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
        throw new Error("Сервер вернул не-JSON ответ.");
    }

    return (await res.json()) as T;
}

export async function fetchNodes(): Promise<Node[]> {
    try {
        return await apiRequest<Node[]>("/nodes");
    } catch (e) {
        console.error(e);
        return [];
    }
}

export async function addNode(
    payload: Omit<Node, "id" | "status" | "has_ssh_key"> & { ssh_key?: string }
): Promise<ApiResponse<{ message?: string }>> {
    try {
        const data = await apiRequest<{ status: string; message?: string }>("/nodes", {
            method: "POST",
            body: JSON.stringify(payload)
        });
        return { success: true, data: { message: data?.message } };
    } catch (e) {
        console.error(e);
        return { success: false, error: String(e) };
    }
}

export async function updateNode(nodeId: number, payload: NodeUpdatePayload): Promise<ApiResponse<{ message?: string }>> {
    try {
        const data = await apiRequest<{ status: string; message?: string }>(`/nodes/${nodeId}`, {
            method: "PUT",
            body: JSON.stringify(payload),
        });
        return { success: true, data: { message: data?.message } };
    } catch (e) {
        console.error(e);
        return { success: false, error: String(e) };
    }
}

export async function fetchSystemOverview(): Promise<SystemOverview> {
    try {
        return await apiRequest<SystemOverview>("/status/overview");
    } catch (e) {
        console.error(e);
        return {
            timestamp: Math.floor(Date.now() / 1000),
            nodes_total: 0,
            nodes_active: 0,
            ssh_reachable: 0,
            ssh_unreachable: 0,
            marzban_connected: false,
            marzban_users_count: 0,
            marzban_error: String(e),
            nodes: [],
        };
    }
}

export async function applyHAProxyConfig(ip: string, config: string): Promise<ApiResponse<null>> {
    try {
        await apiRequest("/haproxy/apply", {
            method: "POST",
            body: JSON.stringify({ ip, config_content: config })
        });
        return { success: true };
    } catch (e) {
        console.error(e);
        return { success: false, error: String(e) };
    }
}

export async function fetchMarzbanStats(): Promise<any> {
    try {
        return await apiRequest("/marzban/stats");
    } catch (e) {
        console.error(e);
        return {
            anomalies: [],
            top_users: []
        };
    }
}

export async function fetchSecurityAudit(): Promise<any> {
    try {
        return await apiRequest("/security/audit");
    } catch (e) {
        console.error(e);
        return {
            banned_ips: [],
            ssh_logins: []
        };
    }
}

export async function executeSysinfo(ip: string): Promise<string[]> {
    try {
        const data = await apiRequest<{ logs: string[] }>("/sysinfo", {
            method: "POST",
            body: JSON.stringify({ ip })
        });
        return data.logs;
    } catch (e) {
        console.error(e);
        return [
            `[ERROR] Не удалось получить sysinfo для ${ip}`,
            String(e),
        ];
    }
}
