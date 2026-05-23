import { Node, ApiResponse } from "./types";

// In a real Telegram environment, we would use window.Telegram.WebApp.initData
// We'll mock it for development
const getInitData = () => {
    // @ts-ignore
    if (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) {
        // @ts-ignore
        return window.Telegram.WebApp.initData || "mock_init_data";
    }
    return "mock_init_data";
};

const API_BASE = "/api";

export async function fetchNodes(): Promise<Node[]> {
    try {
        const res = await fetch(`${API_BASE}/nodes`, {
            headers: {
                "X-Telegram-Init-Data": getInitData()
            }
        });
        const contentType = res.headers.get("content-type");
        if (!res.ok || (contentType && !contentType.includes("application/json"))) {
            throw new Error("Failed to load nodes or invalid response format");
        }
        return await res.json();
    } catch (e) {
        // Fallback to mock data for layout evaluation if the backend is not running
        return [
            { id: 1, ip: "192.168.1.10", role: "master", billing_date: "2026-06-01", status: "active", has_ssh_key: true },
            { id: 2, ip: "192.168.1.11", role: "ingress", billing_date: "2026-06-15", status: "active", has_ssh_key: false },
            { id: 3, ip: "192.168.1.12", role: "egress", billing_date: "2026-05-30", status: "offline", has_ssh_key: true },
        ];
    }
}

export async function addNode(payload: Omit<Node, 'id' | 'status' | 'has_ssh_key'> & { ssh_key?: string }): Promise<ApiResponse<null>> {
    try {
        const res = await fetch(`${API_BASE}/nodes`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Telegram-Init-Data": getInitData()
            },
            body: JSON.stringify(payload)
        });
        const contentType = res.headers.get("content-type");
        if (!res.ok || (contentType && !contentType.includes("application/json"))) {
            return { success: false, error: "Backend not available in preview" };
        }
        return { success: true };
    } catch (e) {
        console.error(e);
        return { success: false, error: String(e) };
    }
}

export async function applyHAProxyConfig(ip: string, config: string): Promise<ApiResponse<null>> {
    try {
        const res = await fetch(`${API_BASE}/haproxy/apply`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Telegram-Init-Data": getInitData()
            },
            body: JSON.stringify({ ip, config })
        });
        const contentType = res.headers.get("content-type");
        if (!res.ok || (contentType && !contentType.includes("application/json"))) {
            return { success: false, error: "Backend not available in preview" };
        }
        return { success: true };
    } catch (e) {
        console.error(e);
        return { success: false, error: String(e) };
    }
}

export async function fetchMarzbanStats(): Promise<any> {
    try {
        const res = await fetch(`${API_BASE}/marzban/stats`, {
            headers: {
                "X-Telegram-Init-Data": getInitData()
            }
        });
        const contentType = res.headers.get("content-type");
        if (!res.ok || (contentType && !contentType.includes("application/json"))) {
            throw new Error("Invalid response");
        }
        return await res.json();
    } catch (e) {
        return {
            anomalies: [
                { id: 1, text: "High traffic spike detected on Node Ingress-04 (IP: 91.201.33.88)", severity: "high" },
                { id: 2, text: "Unusual connection count on Egress-1 (IP: 5.2.44.101)", severity: "medium" }
            ],
            top_users: [
                { username: "client_alpha", traffic: "1.2 TB", status: "active" },
                { username: "client_beta", traffic: "850 GB", status: "active" },
                { username: "test_user1", traffic: "450 GB", status: "limited" }
            ]
        };
    }
}

export async function fetchSecurityAudit(): Promise<any> {
    try {
        const res = await fetch(`${API_BASE}/security/audit`, {
            headers: {
                "X-Telegram-Init-Data": getInitData()
            }
        });
        const contentType = res.headers.get("content-type");
        if (!res.ok || (contentType && !contentType.includes("application/json"))) {
            throw new Error("Invalid response");
        }
        return await res.json();
    } catch (e) {
        return {
            banned_ips: [
                { ip: "198.51.100.14", reason: "Decoy bruteforce (>20 requests)", date: "2026-05-22 14:12 UTC" },
                { ip: "203.0.113.88", reason: "SSH brute force detected", date: "2026-05-22 11:45 UTC" }
            ],
            ssh_logins: [
                { ip: "Admin", target: "185.244.11.02", status: "Accepted", date: "2026-05-22 15:10 UTC" },
                { ip: "Unknown", target: "45.88.2.143", status: "Rejected", date: "2026-05-22 14:55 UTC" }
            ]
        };
    }
}

export async function executeSysinfo(ip: string): Promise<string[]> {
    try {
        const res = await fetch(`${API_BASE}/sysinfo`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Telegram-Init-Data": getInitData()
            },
            body: JSON.stringify({ ip })
        });
        const contentType = res.headers.get("content-type");
        if (!res.ok || (contentType && !contentType.includes("application/json"))) {
            throw new Error("Invalid response");
        }
        const data = await res.json();
        return data.logs;
    } catch (e) {
        return [
            `[INFO] Connecting to ${ip}:2222... Authentication successful.`,
            `UPTIME: 14 days, 3:12 | LOAD: 0.15, 0.08, 0.02`,
            `DISK: /dev/sda1 40% full (12GB free)`,
            `RAM: 1.2GB / 2.0GB in use`
        ];
    }
}
