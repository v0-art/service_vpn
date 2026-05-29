import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Gauge,
  Lock,
  Menu,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

import {
  addNode,
  applyHAProxyConfig,
  deleteNode,
  fetchMarzbanConnection,
  fetchMarzbanNodes,
  fetchNodes,
  fetchSystemOverview,
  importMarzbanNode,
  importMarzbanInventory,
  isTelegramContext,
  reconnectMarzban,
  updateNode,
} from './api';
import { MarzbanStats } from './components/MarzbanStats';
import { SecurityAudit } from './components/SecurityAudit';
import { SystemLogs } from './components/SystemLogs';
import {
  InboundTag,
  MarzbanConnection,
  MarzbanHost,
  MarzbanNode,
  Node as AppNode,
  NodeConnectionStatus,
  NodeCreatePayload,
  NodeRole,
  NodeStatus,
  SystemOverview,
} from './types';

type Tab = 'inventory' | 'monitoring' | 'deploy' | 'haproxy' | 'marzban' | 'security' | 'logs';

type Banner = {
  type: 'success' | 'error' | 'info';
  text: string;
};

type ConfirmAction = {
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
};

const roleLabels: Record<NodeRole, string> = {
  master: 'MASTER',
  ingress: 'INGRESS',
  egress: 'EGRESS',
};

const inboundOptions: Array<{ value: InboundTag; label: string }> = [
  { value: 'IN-RU-DIRECT', label: 'Прямой РФ (IN-RU-DIRECT)' },
  { value: 'IN-EU-DIRECT', label: 'Прямой Иностранный (IN-EU-DIRECT)' },
  { value: 'IN-TRANSIT-GB', label: 'Транзит GB (IN-TRANSIT-GB)' },
  { value: 'IN-TRANSIT-NO', label: 'Транзит NO (IN-TRANSIT-NO)' },
  { value: 'IN-EU-TRANSIT-RECV', label: 'Прием транзита EU (IN-EU-TRANSIT-RECV)' },
  { value: 'IN-EU-DIRECT-WARP', label: 'WARP (IN-EU-DIRECT-WARP)' },
];

const navItems: Array<{ tab: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { tab: 'inventory', label: 'Инвентарь', icon: Server },
  { tab: 'monitoring', label: 'Мониторинг', icon: Gauge },
  { tab: 'deploy', label: 'Добавить сервер', icon: Plus },
  { tab: 'haproxy', label: 'HAProxy', icon: Settings2 },
  { tab: 'marzban', label: 'Marzban', icon: Activity },
  { tab: 'security', label: 'Безопасность', icon: ShieldCheck },
  { tab: 'logs', label: 'Логи', icon: Terminal },
];

function normalizeError(error: string): string {
  return error.replace(/^Error:\s*/i, '').trim();
}

function credentialLabel(node: AppNode): string {
  if (node.has_ssh_key && node.has_ssh_password) {
    return 'ключ + пароль';
  }
  if (node.has_ssh_key) {
    return 'ключ';
  }
  if (node.has_ssh_password) {
    return 'пароль';
  }
  return 'требуется доступ';
}

function roleListLabel(node: AppNode): string {
  if (node.roles && node.roles.length > 0) {
    return node.roles.join(', ');
  }
  return roleLabels[node.role];
}

type InboundDisplayItem = {
  id?: number | string;
  inbound_tag: string;
  remark?: string | null;
  address?: string | null;
  port?: number | null;
  sni?: string | null;
  host?: string | null;
  fingerprint?: string | null;
  is_disabled?: boolean;
};

function inboundDisplayItems(node: AppNode): InboundDisplayItem[] {
  const stored = (node.inbounds || []).filter((inbound) => inbound && inbound.inbound_tag);
  if (stored.length > 0) {
    return stored;
  }

  return [
    {
      id: 'legacy',
      inbound_tag: node.inbound_tag,
      remark: node.name,
      address: node.ip,
      port: node.inbound_port,
      sni: node.group_sni,
      host: node.group_sni,
      fingerprint: node.fingerprint,
      is_disabled: false,
    },
  ];
}

function inboundName(item: InboundDisplayItem): string {
  const remark = String(item.remark || '').trim();
  if (remark && remark !== item.inbound_tag) {
    return `${item.inbound_tag} / ${remark}`;
  }
  return item.inbound_tag;
}

function inboundEndpoint(node: AppNode, item: InboundDisplayItem): string {
  const sni = String(item.sni || item.host || node.group_sni || item.address || node.ip).trim();
  const port = item.port || node.inbound_port || 443;
  return `${sni}:${port}`;
}

function marzbanNodeId(node: MarzbanNode): number | undefined {
  if (node.id === undefined || node.id === null || node.id === '') {
    return undefined;
  }

  const parsed = Number(node.id);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function marzbanNodeAddress(node: MarzbanNode): string {
  return String(node.address || node.ip || node.host || '').trim();
}

function marzbanNodeName(node: MarzbanNode): string {
  const address = marzbanNodeAddress(node);
  return String(node.name || node.remark || address || 'Marzban Node').trim();
}

function marzbanNodeKey(node: MarzbanNode): string {
  const id = marzbanNodeId(node);
  if (id !== undefined) {
    return `id:${id}`;
  }
  return `address:${marzbanNodeAddress(node)}`;
}

function hostListForNode(hosts: Record<string, unknown>, address: string): Array<{ inboundTag: string; host: MarzbanHost }> {
  const result: Array<{ inboundTag: string; host: MarzbanHost }> = [];
  for (const [inboundTag, group] of Object.entries(hosts)) {
    if (!Array.isArray(group)) {
      continue;
    }

    for (const item of group) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const host = item as MarzbanHost;
      if (String(host.address || '').trim() === address) {
        result.push({ inboundTag, host });
      }
    }
  }
  return result;
}

function calculateAppScale(width: number, height: number): number {
  const widthScale = width / 430;
  const heightScale = height / 900;
  const rawScale = Math.min(widthScale, heightScale);
  return Number(Math.max(0.9, Math.min(1.08, rawScale)).toFixed(3));
}

function NodeStatusBadge({ node, connection }: { node: AppNode; connection?: NodeConnectionStatus }) {
  if (node.provision_status === 'provisioning') {
    return <span className="px-2 py-1 rounded text-[11px] font-bold uppercase tracking-wider bg-app-warning/10 text-app-warning">Провижининг</span>;
  }

  if (node.provision_status === 'error') {
    return <span className="px-2 py-1 rounded text-[11px] font-bold uppercase tracking-wider bg-app-danger/10 text-app-danger">Ошибка настройки</span>;
  }

  if (!connection) {
    return <span className="px-2 py-1 rounded text-[11px] font-bold uppercase tracking-wider bg-app-border/20 text-app-muted">Ожидание проверки</span>;
  }

  if (!connection.checked) {
    return <span className="px-2 py-1 rounded text-[11px] font-bold uppercase tracking-wider bg-app-border/20 text-app-muted">Не проверялся</span>;
  }

  if (connection.connected) {
    return <span className="px-2 py-1 rounded text-[11px] font-bold uppercase tracking-wider bg-app-success/10 text-app-success">SSH доступен</span>;
  }

  return <span className="px-2 py-1 rounded text-[11px] font-bold uppercase tracking-wider bg-app-danger/10 text-app-danger">SSH недоступен</span>;
}

function NavigationMenu({ activeTab, onSelect }: { activeTab: Tab; onSelect: (tab: Tab) => void }) {
  return (
    <nav className="py-4 flex-grow flex flex-col gap-1">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.tab;
        return (
          <button
            key={item.tab}
            onClick={() => onSelect(item.tab)}
            className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm cursor-pointer transition-colors ${
              isActive ? 'text-app-text bg-app-accent/10 border-r-[3px] border-app-accent' : 'text-app-muted hover:text-app-text'
            }`}
          >
            <Icon className="w-4 h-4" /> {item.label}
          </button>
        );
      })}
    </nav>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('inventory');
  const [nodes, setNodes] = useState<AppNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [editingNode, setEditingNode] = useState<AppNode | null>(null);
  const [appScale, setAppScale] = useState(1);
  const [marzbanConn, setMarzbanConn] = useState<MarzbanConnection | null>(null);
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const inTelegram = isTelegramContext();

  const loadNodes = async () => {
    setLoading(true);
    const data = await fetchNodes();
    setNodes(data);
    setLoading(false);
  };

  const loadOverview = async () => {
    setOverviewLoading(true);
    const data = await fetchSystemOverview();
    setOverview(data);
    setOverviewLoading(false);
  };

  const loadMarzbanConn = async () => {
    const status = await fetchMarzbanConnection();
    setMarzbanConn(status);
  };

  const refreshAll = async () => {
    await Promise.all([loadNodes(), loadOverview(), loadMarzbanConn()]);
  };

  const openTab = (tab: Tab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  useEffect(() => {
    // @ts-ignore
    const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
    tg?.ready?.();
    tg?.expand?.();

    if (!inTelegram) {
      return;
    }

    refreshAll();
  }, [inTelegram]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onResize = () => {
      setAppScale(calculateAppScale(window.innerWidth, window.innerHeight));
    };

    onResize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  const connectionByIp = useMemo<Map<string, NodeConnectionStatus>>(() => {
    const map = new Map<string, NodeConnectionStatus>();
    for (const node of overview?.nodes || []) {
      map.set(node.ip, node);
    }
    return map;
  }, [overview]);

  const marzbanConnected = Boolean(marzbanConn?.connected ?? overview?.marzban_connected);
  const nodesTotalCount = Math.max(overview?.nodes_total ?? 0, nodes.length);
  const activeNodesCount = Math.max(overview?.nodes_active ?? 0, nodes.filter((node) => node.status === 'active').length);
  const sshReachableCount = Math.max(
    overview?.ssh_reachable ?? 0,
    nodes.filter((node) => connectionByIp.get(node.ip)?.connected).length
  );
  const sshStatusText = `${sshReachableCount}/${activeNodesCount}`;

  const reconnectMarzbanNow = async () => {
    setReconnectBusy(true);
    const res = await reconnectMarzban();
    setReconnectBusy(false);

    if (res.success) {
      setBanner({ type: 'success', text: res.data?.message || 'Подключение к Marzban восстановлено.' });
      await refreshAll();
      return;
    }

    setBanner({ type: 'error', text: `Marzban: ${normalizeError(res.error || 'ошибка переподключения')}` });
    await loadMarzbanConn();
  };

  const runMarzbanImport = async () => {
    setImportBusy(true);
    const res = await importMarzbanInventory();
    setImportBusy(false);

    if (res.success && res.data) {
      const unmatched = res.data.unmatched_hosts?.length || 0;
      setBanner({
        type: unmatched > 0 ? 'info' : 'success',
        text: `${res.data.message || 'Импорт Marzban завершен.'} Добавлено: ${res.data.imported}, обновлено: ${res.data.updated}, inbound: ${res.data.inbounds}${unmatched ? `, hosts без node: ${unmatched}` : ''}.`,
      });
      await refreshAll();
      return;
    }

    setBanner({ type: 'error', text: `Импорт Marzban не выполнен: ${normalizeError(res.error || 'неизвестная ошибка')}` });
  };

  const handleDeleteNode = async (node: AppNode) => {
    setConfirmAction({
      title: 'Удалить сервер',
      text: `Сервер "${node.name}" (${node.ip}) будет удален из панели, Marzban и очищен по SSH, если доступ есть.`,
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: async () => {
        const res = await deleteNode(node.id, true);
        if (res.success) {
          setBanner({ type: 'success', text: res.data?.message || `Сервер ${node.name} удален.` });
          await refreshAll();
          return;
        }

        setBanner({ type: 'error', text: `Не удалось удалить сервер: ${normalizeError(res.error || 'неизвестная ошибка')}` });
      },
    });
  };

  if (!inTelegram) {
    return (
      <div className="min-h-screen w-full bg-app-bg text-app-text flex items-center justify-center">
        <div className="bg-app-card border border-app-border rounded-lg p-8 text-center max-w-md">
          <div className="text-5xl font-extrabold text-app-danger mb-3">404</div>
          <div className="text-sm font-semibold mb-2">Страница не найдена</div>
          <div className="text-xs text-app-muted">Панель открывается только через кнопку в Telegram-боте.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell flex h-screen w-full bg-app-bg text-app-text" style={{ ['--app-zoom' as '--app-zoom']: appScale }}>
      <aside className="hidden md:flex w-[220px] shrink-0 border-r border-app-border flex-col bg-app-card/50">
        <div className="p-6 border-b border-app-border">
          <div className="font-extrabold text-[18px] tracking-[1px] flex items-center gap-2.5 text-app-accent">
            <div className="w-6 h-6 bg-app-accent rounded-sm flex items-center justify-center">
              <ShieldCheck className="w-4 h-4 text-app-bg" />
            </div>
            LUFFY TOWER
          </div>
        </div>

        <NavigationMenu activeTab={activeTab} onSelect={openTab} />

        <div className="p-6 border-t border-app-border">
          <div className="text-[10px] text-app-muted mb-2 font-semibold tracking-wider uppercase">Панель администратора</div>
          <div className="text-xs font-mono">Режим: ADMIN</div>
          <div className="text-app-success text-[10px] mt-1.5 flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-app-success" />
            Подключено через Telegram
          </div>
        </div>
      </aside>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div className="fixed inset-0 z-40 md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button className="absolute inset-0 bg-black/60" onClick={() => setMobileMenuOpen(false)} aria-label="Закрыть меню" />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ duration: 0.2 }}
              className="relative z-10 h-full w-[270px] border-r border-app-border bg-app-card flex flex-col"
            >
              <div className="p-5 border-b border-app-border flex items-center justify-between">
                <div className="font-extrabold text-[16px] tracking-[1px] text-app-accent">LUFFY TOWER</div>
                <button onClick={() => setMobileMenuOpen(false)} className="p-1.5 border border-app-border rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <NavigationMenu activeTab={activeTab} onSelect={openTab} />

              <div className="p-5 border-t border-app-border text-xs text-app-muted">Панель доступна только из Telegram Mini App</div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="flex-1 flex flex-col min-w-0">
        <div className="h-auto min-h-16 border-b border-app-border bg-app-card shrink-0 px-4 md:px-6 py-3">
          <div className="flex items-center justify-between gap-2 md:hidden mb-3">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="px-3 py-2 border border-app-border rounded-md text-xs font-semibold flex items-center gap-2"
            >
              <Menu className="w-4 h-4" /> Меню
            </button>
            <div className="text-sm font-semibold text-app-accent">LUFFY TOWER</div>
            <button onClick={() => openTab('deploy')} className="px-3 py-2 bg-app-accent text-black rounded-md text-xs font-semibold">
              + Сервер
            </button>
          </div>

          <div className="flex items-start md:items-center justify-between gap-3 flex-col md:flex-row">
            <div className="flex gap-2 text-xs font-mono flex-wrap">
              <StatusBadge label="Marzban" loading={overviewLoading} ok={marzbanConnected} okText="подключен" badText={marzbanConn?.error || 'ошибка подключения'} />
              <StatusBadge
                label="Auth"
                loading={overviewLoading}
                ok={!marzbanConn?.error_code || !marzbanConn.error_code.startsWith('auth_')}
                okText="OK"
                badText={marzbanConn?.error_code === 'auth_401' || marzbanConn?.error_code === 'auth_403' ? `AUTH ${marzbanConn?.http_status}` : 'нет данных'}
              />
              <StatusBadge
                label="SSH"
                loading={overviewLoading}
                ok={activeNodesCount === 0 || sshReachableCount === activeNodesCount}
                okText={sshStatusText}
                badText={sshStatusText}
              />
              <StatusBadge
                label="Серверы"
                loading={overviewLoading}
                ok={nodesTotalCount > 0}
                okText={`${nodesTotalCount}`}
                badText="0"
              />
            </div>

            <div className="flex gap-2 md:gap-3 flex-wrap">
              {!marzbanConnected && (
                <button
                  onClick={reconnectMarzbanNow}
                  disabled={reconnectBusy}
                  className="px-3 py-2 border border-app-warning text-app-warning rounded-md text-xs font-semibold cursor-pointer transition-opacity hover:opacity-80 flex items-center gap-2 disabled:opacity-60"
                >
                  {reconnectBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Network className="w-3.5 h-3.5" />} Переподключить Marzban
                </button>
              )}
              <button
                onClick={() =>
                  setConfirmAction({
                    title: 'Импорт Marzban',
                    text: 'LUFFY перечитает все Marzban Nodes и inbound hosts, сопоставит их по IP и обновит локальный инвентарь без изменения Marzban.',
                    confirmLabel: 'Импортировать',
                    onConfirm: runMarzbanImport,
                  })
                }
                disabled={importBusy}
                className="px-3 py-2 border border-app-border rounded-md text-xs font-semibold cursor-pointer transition-opacity hover:opacity-80 flex items-center gap-2 text-app-text disabled:opacity-60"
              >
                <Network className={`w-3.5 h-3.5 ${importBusy ? 'animate-pulse' : ''}`} /> Импорт Marzban
              </button>
              <button
                onClick={refreshAll}
                className="px-4 py-2 border border-app-border rounded-md text-xs font-semibold cursor-pointer transition-opacity hover:opacity-80 flex items-center gap-2 text-app-text"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading || overviewLoading ? 'animate-spin' : ''}`} /> Обновить
              </button>
            </div>
          </div>
        </div>

        <div className="p-3 md:p-5 flex-grow overflow-y-auto">
          {banner && (
            <div
              className={`mb-4 border rounded-lg p-3 text-xs font-mono flex items-center gap-2 ${
                banner.type === 'success'
                  ? 'border-app-success/30 bg-app-success/10 text-app-success'
                  : banner.type === 'error'
                  ? 'border-app-danger/30 bg-app-danger/10 text-app-danger'
                  : 'border-app-border bg-app-card text-app-text'
              }`}
            >
              {banner.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : banner.type === 'error' ? (
                <XCircle className="w-4 h-4 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0" />
              )}
              {banner.text}
            </div>
          )}

          <AnimatePresence mode="wait">
            {activeTab === 'inventory' && (
              <motion.div key="inventory" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }}>
                <InventoryView
                  nodes={nodes}
                  loading={loading}
                  connectionByIp={connectionByIp}
                  onEdit={(node) => setEditingNode(node)}
                  onDelete={handleDeleteNode}
                />
              </motion.div>
            )}

            {activeTab === 'monitoring' && (
              <motion.div key="monitoring" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="flex flex-col h-full w-full">
                <MonitoringView
                  nodes={nodes}
                  overview={overview}
                  marzbanConn={marzbanConn}
                  loading={overviewLoading}
                  connectionByIp={connectionByIp}
                  onRefresh={refreshAll}
                />
              </motion.div>
            )}

            {activeTab === 'deploy' && (
              <motion.div key="deploy" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="flex flex-col h-full max-w-2xl mx-auto w-full pt-2 md:pt-8">
                <DeployForm
                  onSuccess={async (message, isPartial) => {
                    setBanner({ type: isPartial ? 'info' : 'success', text: message });
                    await refreshAll();
                    openTab('inventory');
                  }}
                  onError={(message) => {
                    setBanner({ type: 'error', text: message });
                  }}
                />
              </motion.div>
            )}

            {activeTab === 'haproxy' && (
              <motion.div key="haproxy" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="flex flex-col h-full max-w-3xl mx-auto w-full pt-2 md:pt-4">
                <HAProxyForm nodes={nodes} />
              </motion.div>
            )}

            {activeTab === 'marzban' && (
              <motion.div key="marzban" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="flex flex-col h-full w-full">
                <MarzbanStats />
              </motion.div>
            )}

            {activeTab === 'security' && (
              <motion.div key="security" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="flex flex-col h-full w-full">
                <SecurityAudit />
              </motion.div>
            )}

            {activeTab === 'logs' && (
              <motion.div key="logs" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="flex flex-col h-full w-full">
                <SystemLogs nodes={nodes} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <AnimatePresence>
        {editingNode && (
          <EditNodeModal
            node={editingNode}
            onClose={() => setEditingNode(null)}
            onSuccess={async (message, isPartial) => {
              setBanner({ type: isPartial ? 'info' : 'success', text: message });
              setEditingNode(null);
              await refreshAll();
            }}
            onError={(message) => {
              setBanner({ type: 'error', text: message });
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {confirmAction && (
          <ConfirmDialog
            action={confirmAction}
            onClose={() => setConfirmAction(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusBadge({
  label,
  loading,
  ok,
  okText,
  badText,
}: {
  label: string;
  loading: boolean;
  ok: boolean;
  okText: string;
  badText: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-app-bg border border-app-border">
      {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : ok ? <CheckCircle2 className="w-3.5 h-3.5 text-app-success" /> : <XCircle className="w-3.5 h-3.5 text-app-danger" />}
      <span className="hidden sm:inline">{label}</span>{' '}
      <span className={`font-semibold ${ok ? 'text-app-success' : 'text-app-danger'}`}>{ok ? okText : badText}</span>
    </div>
  );
}

function ConfirmDialog({ action, onClose }: { action: ConfirmAction; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await action.onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div className="fixed inset-0 z-[60]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button className="absolute inset-0 bg-black/70" onClick={busy ? undefined : onClose} aria-label="Закрыть подтверждение" />
      <div className="relative z-10 min-h-screen p-4 flex items-center justify-center">
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 18, opacity: 0 }}
          className="w-full max-w-md bg-app-card border border-app-border rounded-lg"
        >
          <div className="p-4 border-b border-app-border flex items-center justify-between">
            <div className="text-sm font-semibold uppercase tracking-wide text-app-muted">{action.title}</div>
            <button onClick={busy ? undefined : onClose} className="p-1.5 border border-app-border rounded">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-4 text-sm text-app-text/90 leading-relaxed">{action.text}</div>
          <div className="grid grid-cols-2 gap-3 p-4 border-t border-app-border">
            <button type="button" onClick={onClose} disabled={busy} className="w-full border border-app-border text-app-text font-semibold py-2.5 rounded-md text-[13px] disabled:opacity-50">
              Отмена
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={busy}
              className={`w-full font-semibold py-2.5 rounded-md text-[13px] disabled:opacity-50 flex items-center justify-center gap-2 ${
                action.danger ? 'bg-app-danger text-white' : 'bg-app-accent text-black'
              }`}
            >
              {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {busy ? 'Выполняется...' : action.confirmLabel}
            </button>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

function MonitoringView({
  nodes,
  overview,
  marzbanConn,
  loading,
  connectionByIp,
  onRefresh,
}: {
  nodes: AppNode[];
  overview: SystemOverview | null;
  marzbanConn: MarzbanConnection | null;
  loading: boolean;
  connectionByIp: Map<string, NodeConnectionStatus>;
  onRefresh: () => Promise<void>;
}) {
  const activeNodes = nodes.filter((node) => node.status === 'active').length;
  const nodesTotal = Math.max(overview?.nodes_total ?? 0, nodes.length);
  const nodesActive = Math.max(overview?.nodes_active ?? 0, activeNodes);
  const sshReachable = Math.max(
    overview?.ssh_reachable ?? 0,
    nodes.filter((node) => connectionByIp.get(node.ip)?.connected).length
  );
  const sshUnreachable = Math.max(overview?.ssh_unreachable ?? 0, nodesActive - sshReachable);
  const usersCount = marzbanConn?.users_count ?? overview?.marzban_users_count ?? 0;
  const marzbanOk = Boolean(marzbanConn?.connected ?? overview?.marzban_connected);

  return (
    <div className="flex flex-col gap-4 max-w-6xl mx-auto w-full">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Мониторинг кластера</div>
          <div className="text-xs text-app-muted mt-1 font-mono">Обновлено: {overview?.timestamp ? new Date(overview.timestamp * 1000).toLocaleString('ru-RU') : 'нет данных'}</div>
        </div>
        <button onClick={onRefresh} className="px-3 py-2 border border-app-border rounded-md text-xs font-semibold cursor-pointer transition-opacity hover:opacity-80 flex items-center gap-2">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Обновить
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MetricTile label="Серверы" value={`${nodesTotal}`} detail={`активно ${nodesActive}`} tone={nodesTotal > 0 ? 'success' : 'danger'} />
        <MetricTile label="SSH" value={`${sshReachable}/${nodesActive}`} detail={`недоступно ${sshUnreachable}`} tone={sshUnreachable === 0 ? 'success' : 'danger'} />
        <MetricTile label="Marzban" value={marzbanOk ? 'connected' : 'error'} detail={marzbanConn?.error_code || overview?.marzban_error_code || 'статус'} tone={marzbanOk ? 'success' : 'danger'} />
        <MetricTile label="Пользователи" value={`${usersCount}`} detail="данные Marzban" tone="neutral" />
      </div>

      <div className="bg-app-card border border-app-border rounded-lg overflow-hidden">
        <div className="p-4 border-b border-app-border flex items-center gap-2">
          <Gauge className="w-4 h-4 text-app-accent" />
          <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Состояние нод</span>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-left border-collapse min-w-[900px]">
            <thead>
              <tr>
                <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Нода</th>
                <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">SSH</th>
                <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Доступ</th>
                <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Marzban</th>
                <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Inbound</th>
              </tr>
            </thead>
            <tbody>
              {nodes.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-app-muted text-xs font-mono uppercase tracking-widest">
                    Серверы еще не добавлены
                  </td>
                </tr>
              ) : (
                nodes.map((node) => {
                  const connection = connectionByIp.get(node.ip);
                  return (
                    <tr key={node.id} className="hover:bg-app-text/5 transition-colors">
                      <td className="p-4 border-b border-app-border">
                        <div className="font-semibold text-[13px]">{node.name}</div>
                        <div className="font-mono text-xs text-app-accent mt-1">{node.ip}:{node.ssh_port}</div>
                      </td>
                      <td className="p-4 border-b border-app-border">
                        <NodeStatusBadge node={node} connection={connection} />
                        {connection?.error && <div className="mt-1 text-[11px] text-app-danger max-w-[260px] truncate">{connection.error}</div>}
                      </td>
                      <td className="p-4 border-b border-app-border text-[12px] font-mono">
                        {credentialLabel(node)}
                      </td>
                      <td className="p-4 border-b border-app-border text-[12px] font-mono">
                        <div>{node.marzban_node_status || 'unknown'}</div>
                        {node.marzban_last_error && <div className="text-app-danger mt-1 max-w-[240px] truncate">{node.marzban_last_error}</div>}
                      </td>
                      <td className="p-4 border-b border-app-border text-[12px] font-mono">
                        <div className="space-y-1">
                          {inboundDisplayItems(node).map((item, index) => (
                            <div key={`${item.inbound_tag}-${item.id || index}`} className="text-app-muted leading-snug">
                              <div className="text-app-text break-words">{inboundName(item)}</div>
                              <div className="text-[11px] break-words">{inboundEndpoint(node, item)}{item.is_disabled ? ' · disabled' : ''}</div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          ['Порты ingress', '15 минут'],
          ['Decoy watchdog', '5 минут'],
          ['Latency links', '30 минут'],
          ['SSH audit', '15 минут'],
          ['UFW scanners', '15 минут'],
          ['Billing', '10:00 ежедневно'],
        ].map(([name, interval]) => (
          <div key={name} className="border border-app-border rounded-lg bg-app-card p-3">
            <div className="text-[11px] uppercase tracking-wide text-app-muted font-semibold">{name}</div>
            <div className="text-xs font-mono text-app-text mt-1">{interval}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricTile({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'success' | 'danger' | 'neutral' }) {
  const toneClass = tone === 'success' ? 'text-app-success' : tone === 'danger' ? 'text-app-danger' : 'text-app-accent';
  return (
    <div className="bg-app-card border border-app-border rounded-lg p-4">
      <div className="text-[11px] uppercase tracking-wide text-app-muted font-semibold">{label}</div>
      <div className={`mt-2 text-xl font-mono font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-app-muted font-mono">{detail}</div>
    </div>
  );
}

function InventoryView({
  nodes,
  loading,
  connectionByIp,
  onEdit,
  onDelete,
}: {
  nodes: AppNode[];
  loading: boolean;
  connectionByIp: Map<string, NodeConnectionStatus>;
  onEdit: (node: AppNode) => void;
  onDelete: (node: AppNode) => void;
}) {
  return (
    <div className="bg-app-card border border-app-border rounded-lg flex flex-col flex-1 pb-2 overflow-hidden">
      <div className="p-4 border-b border-app-border flex justify-between items-center shrink-0">
        <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Инвентарь серверов</span>
        <span className="text-xs text-app-muted font-mono">Всего: {nodes.length}</span>
      </div>

      <div className="hidden md:block flex-1 overflow-auto">
        <table className="w-full text-left border-collapse min-w-[1200px]">
          <thead>
            <tr>
              <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Имя</th>
              <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">IP адрес</th>
              <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Роль</th>
              <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">SSH</th>
              <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Inbound</th>
              <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">SNI:порт</th>
              <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Статус</th>
              <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Действия</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="p-8 text-center text-app-muted text-xs font-mono uppercase tracking-widest">
                  Загрузка серверов...
                </td>
              </tr>
            ) : nodes.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-8 text-center text-app-muted text-xs font-mono uppercase tracking-widest">
                  Серверы еще не добавлены
                </td>
              </tr>
            ) : (
              nodes.map((node) => (
                <NodeRow key={node.id} node={node} connection={connectionByIp.get(node.ip)} onEdit={() => onEdit(node)} onDelete={() => onDelete(node)} />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="md:hidden p-3 space-y-3">
        {loading ? (
          <div className="text-center py-8 text-xs text-app-muted font-mono">Загрузка серверов...</div>
        ) : nodes.length === 0 ? (
          <div className="text-center py-8 text-xs text-app-muted font-mono">Серверы еще не добавлены</div>
        ) : (
          nodes.map((node) => (
            <div key={node.id} className="border border-app-border rounded-lg p-3 bg-app-bg/40">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-semibold text-sm text-app-text">{node.name}</div>
                  <div className="font-mono text-app-accent text-xs">{node.ip}:{node.ssh_port}</div>
                </div>
                <NodeStatusBadge node={node} connection={connectionByIp.get(node.ip)} />
              </div>
              <div className="mt-2 text-xs text-app-muted">Роли: {roleListLabel(node)}</div>
              <div className="mt-2 space-y-1">
                {inboundDisplayItems(node).map((item, index) => (
                  <div key={`${item.inbound_tag}-${item.id || index}`} className="text-xs text-app-muted font-mono">
                    <span className="text-app-text">{inboundName(item)}</span>
                    <span className="block text-[11px]">{inboundEndpoint(node, item)}{item.is_disabled ? ' · disabled' : ''}</span>
                  </div>
                ))}
              </div>
              <div className="mt-1 text-xs text-app-muted">SSH: {node.ssh_username || 'root'}@{node.ssh_port}, {credentialLabel(node)}</div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  onClick={() => onEdit(node)}
                  className="w-full border border-app-border rounded-md py-2 text-xs font-semibold flex items-center justify-center gap-2"
                >
                  <Pencil className="w-3.5 h-3.5" /> Изменить
                </button>
                <button
                  onClick={() => onDelete(node)}
                  className="w-full border border-app-danger/40 text-app-danger rounded-md py-2 text-xs font-semibold flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Удалить
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const NodeRow: React.FC<{
  node: AppNode;
  connection?: NodeConnectionStatus;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ node, connection, onEdit, onDelete }) => {
  const inboundItems = inboundDisplayItems(node);

  return (
    <tr className="hover:bg-app-text/5 transition-colors group relative">
      <td className="p-4 border-b border-app-border text-[13px] font-semibold">{node.name}</td>
      <td className="p-4 border-b border-app-border text-[13px]">
        <span className="font-mono text-app-accent font-medium">{node.ip}</span>
      </td>
      <td className="p-4 border-b border-app-border text-[13px]">
        <span className="opacity-80">{roleListLabel(node)}</span>
      </td>
      <td className="p-4 border-b border-app-border text-[13px] font-mono opacity-80">
        {node.ssh_port}
        <div className="mt-1 text-[10px]">
          {node.has_credentials ? (
            <span className="inline-flex items-center gap-1 text-app-success"><Lock className="w-3 h-3" /> {credentialLabel(node)}</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-app-warning"><AlertCircle className="w-3 h-3" /> нужен доступ</span>
          )}
        </div>
      </td>
      <td className="p-4 border-b border-app-border text-[12px] font-mono">
        <div className="space-y-1.5 max-w-[280px]">
          {inboundItems.map((item, index) => (
            <div key={`${item.inbound_tag}-${item.id || index}`} className="leading-snug">
              <div className="text-app-text break-words">{inboundName(item)}</div>
              {item.is_disabled && <div className="text-app-warning text-[10px] uppercase tracking-wide">disabled</div>}
            </div>
          ))}
        </div>
      </td>
      <td className="p-4 border-b border-app-border text-[12px] font-mono">
        <div className="space-y-1.5 max-w-[240px]">
          {inboundItems.map((item, index) => (
            <div key={`${item.inbound_tag}-${item.id || index}`} className="text-app-muted break-words">
              {inboundEndpoint(node, item)}
            </div>
          ))}
        </div>
      </td>
      <td className="p-4 border-b border-app-border text-[13px]">
        <NodeStatusBadge node={node} connection={connection} />
      </td>
      <td className="p-4 border-b border-app-border text-[13px]">
        <div className="flex gap-2">
          <button onClick={onEdit} className="px-3 py-1.5 border border-app-border rounded text-xs font-semibold hover:bg-app-bg transition-colors flex items-center gap-1.5">
            <Pencil className="w-3.5 h-3.5" /> Изменить
          </button>
          <button onClick={onDelete} className="px-3 py-1.5 border border-app-danger/40 text-app-danger rounded text-xs font-semibold hover:bg-app-danger/10 transition-colors flex items-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5" /> Удалить
          </button>
        </div>
      </td>
    </tr>
  );
};

function DeployForm({
  onSuccess,
  onError,
}: {
  onSuccess: (message: string, partial: boolean) => void;
  onError: (message: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [addMode, setAddMode] = useState<'existing' | 'new'>('existing');
  const [marzbanLoading, setMarzbanLoading] = useState(false);
  const [marzbanNodes, setMarzbanNodes] = useState<MarzbanNode[]>([]);
  const [marzbanHosts, setMarzbanHosts] = useState<Record<string, unknown>>({});
  const [selectedMarzbanKey, setSelectedMarzbanKey] = useState('');

  const selectedMarzbanNode = useMemo(
    () => marzbanNodes.find((node) => marzbanNodeKey(node) === selectedMarzbanKey) || null,
    [marzbanNodes, selectedMarzbanKey]
  );
  const selectedMarzbanAddress = selectedMarzbanNode ? marzbanNodeAddress(selectedMarzbanNode) : '';
  const selectedMarzbanHosts = useMemo(
    () => hostListForNode(marzbanHosts, selectedMarzbanAddress),
    [marzbanHosts, selectedMarzbanAddress]
  );

  const reloadMarzbanNodes = async () => {
    setMarzbanLoading(true);
    const snapshot = await fetchMarzbanNodes();
    setMarzbanNodes(snapshot.nodes || []);
    setMarzbanHosts(snapshot.hosts || {});
    setSelectedMarzbanKey((current) => {
      if (current && snapshot.nodes.some((node) => marzbanNodeKey(node) === current)) {
        return current;
      }
      return snapshot.nodes[0] ? marzbanNodeKey(snapshot.nodes[0]) : '';
    });
    setMarzbanLoading(false);
  };

  useEffect(() => {
    if (addMode === 'existing' && marzbanNodes.length === 0 && !marzbanLoading) {
      reloadMarzbanNodes();
    }
  }, [addMode]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const sshKeyRaw = String(formData.get('ssh_key') || '');
    const sshPasswordRaw = String(formData.get('ssh_password') || '');

    if (addMode === 'existing') {
      if (!selectedMarzbanNode || !selectedMarzbanAddress) {
        setLoading(false);
        onError('Выберите Marzban Node для импорта.');
        return;
      }

      if (!sshKeyRaw.trim() && !sshPasswordRaw.trim()) {
        setLoading(false);
        onError('Добавьте SSH ключ или пароль для выбранной Marzban Node.');
        return;
      }

      const res = await importMarzbanNode({
        marzban_node_id: marzbanNodeId(selectedMarzbanNode),
        address: selectedMarzbanAddress,
        billing_date: String(formData.get('billing') || '').trim() || undefined,
        ssh_username: String(formData.get('ssh_username') || 'root').trim(),
        ssh_port: Number(formData.get('ssh_port') || 2222),
        ssh_key: sshKeyRaw.trim() || undefined,
        ssh_password: sshPasswordRaw.trim() || undefined,
      });
      setLoading(false);

      if (res.success) {
        const inboundText = typeof res.data?.inbounds === 'number' ? ` Inbound: ${res.data.inbounds}.` : '';
        onSuccess(res.data?.message ? `${res.data.message}${inboundText}` : `Marzban Node ${marzbanNodeName(selectedMarzbanNode)} импортирована.`, res.data?.status === 'partial');
        return;
      }

      onError(`Не удалось импортировать Marzban Node: ${normalizeError(res.error || 'Неизвестная ошибка')}`);
      return;
    }

    const payload: NodeCreatePayload = {
      name: String(formData.get('name') || '').trim(),
      ip: String(formData.get('ip') || '').trim(),
      role: formData.get('role') as NodeRole,
      billing_date: String(formData.get('billing') || '').trim(),
      ssh_username: String(formData.get('ssh_username') || 'root').trim(),
      ssh_port: Number(formData.get('ssh_port') || 22),
      ssh_key: sshKeyRaw || undefined,
      ssh_password: sshPasswordRaw || undefined,
      inbound_tag: formData.get('inbound_tag') as InboundTag,
      inbound_port: Number(formData.get('inbound_port') || 443),
      group_sni: String(formData.get('group_sni') || '').trim(),
      fingerprint: String(formData.get('fingerprint') || '').trim(),
      add_mode: addMode,
    };

    const res = await addNode(payload);
    setLoading(false);

    if (res.success) {
      e.currentTarget.reset();
      onSuccess(res.data?.message || `Сервер ${payload.name} добавлен.`, false);
      return;
    }

    if (res.data?.status === 'partial') {
      onSuccess(res.data?.message || 'Сервер добавлен частично.', true);
      return;
    }

    onError(`Не удалось добавить сервер: ${normalizeError(res.error || 'Неизвестная ошибка')}`);
  };

  return (
    <div className="bg-app-card border border-app-border rounded-lg flex flex-col">
      <div className="p-4 border-b border-app-border">
        <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Добавление и подключение сервера</span>
      </div>
      <form onSubmit={handleSubmit} className="p-4 md:p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setAddMode('existing')}
            className={`text-left p-3 rounded-md border transition-colors ${
              addMode === 'existing'
                ? 'border-app-success bg-app-success/10'
                : 'border-app-border bg-app-bg/40'
            }`}
          >
            <div className="text-sm font-semibold text-app-text">Существующий сервер</div>
            <div className="text-xs mt-1 text-app-muted">
              Безопасный режим: только добавление в панель, без изменений в Marzban и на сервере.
            </div>
          </button>

          <button
            type="button"
            onClick={() => setAddMode('new')}
            className={`text-left p-3 rounded-md border transition-colors ${
              addMode === 'new'
                ? 'border-app-warning bg-app-warning/10'
                : 'border-app-border bg-app-bg/40'
            }`}
          >
            <div className="text-sm font-semibold text-app-text">Новый сервер</div>
            <div className="text-xs mt-1 text-app-muted">
              Полный автодеплой: установка утилит + регистрация в Marzban + привязка к группе.
            </div>
          </button>
        </div>

        <div
          className={`text-xs border rounded-md px-3 py-2 font-mono ${
            addMode === 'existing'
              ? 'border-app-success/30 text-app-success bg-app-success/10'
              : 'border-app-warning/30 text-app-warning bg-app-warning/10'
          }`}
        >
          {addMode === 'existing'
            ? 'Режим SAFE: сеть не меняем, только карточка сервера в LUFFY TOWER.'
            : 'Режим DEPLOY: будут изменения в инфраструктуре. Используй только для новых нод.'}
        </div>

        {addMode === 'existing' ? (
          <>
            <div>
              <div className="flex items-center justify-between gap-3 mb-2">
                <label className="block text-[11px] text-app-muted uppercase tracking-wide font-semibold">Marzban Node</label>
                <button
                  type="button"
                  onClick={reloadMarzbanNodes}
                  disabled={marzbanLoading}
                  className="px-2.5 py-1.5 border border-app-border rounded text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${marzbanLoading ? 'animate-spin' : ''}`} />
                  Обновить
                </button>
              </div>
              <select
                required
                value={selectedMarzbanKey}
                onChange={(event) => setSelectedMarzbanKey(event.target.value)}
                disabled={marzbanLoading || marzbanNodes.length === 0}
                className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono"
              >
                <option value="" disabled>
                  {marzbanLoading ? 'Загрузка Marzban Nodes...' : 'Выберите Marzban Node...'}
                </option>
                {marzbanNodes.map((node) => {
                  const address = marzbanNodeAddress(node);
                  const status = String(node.status || 'unknown');
                  return (
                    <option key={marzbanNodeKey(node)} value={marzbanNodeKey(node)}>
                      {marzbanNodeName(node)} • {address} • {status}
                    </option>
                  );
                })}
              </select>
            </div>

            {selectedMarzbanNode && (
              <div className="border border-app-border rounded-md bg-app-bg/40 p-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div>
                    <div className="text-app-muted uppercase text-[10px] font-semibold mb-1">IP</div>
                    <div className="font-mono text-app-accent">{selectedMarzbanAddress}</div>
                  </div>
                  <div>
                    <div className="text-app-muted uppercase text-[10px] font-semibold mb-1">Статус</div>
                    <div className="font-mono">{String(selectedMarzbanNode.status || 'unknown')}</div>
                  </div>
                  <div>
                    <div className="text-app-muted uppercase text-[10px] font-semibold mb-1">Inbound</div>
                    <div className="font-mono">{selectedMarzbanHosts.length}</div>
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  {selectedMarzbanHosts.length === 0 ? (
                    <div className="text-xs text-app-warning font-mono">hosts по IP этой Node не найдены</div>
                  ) : (
                    selectedMarzbanHosts.map((item, index) => (
                      <div key={`${item.inboundTag}-${index}-${String(item.host.remark || item.host.address || item.host.sni)}`} className="text-[11px] font-mono text-app-muted flex flex-wrap gap-x-2">
                        <span className="text-app-text">{item.inboundTag}</span>
                        <span>{String(item.host.remark || 'без имени')}</span>
                        <span>{String(item.host.sni || item.host.host || 'без SNI')}:{String(item.host.port || '443')}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">SSH пользователь</label>
                <input required type="text" defaultValue="root" name="ssh_username" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">SSH порт</label>
                <input required type="number" min={1} max={65535} defaultValue={2222} name="ssh_port" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Дата оплаты</label>
                <input type="date" name="billing" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" style={{ colorScheme: 'dark' }} />
              </div>
            </div>

            <div>
              <label className="flex text-[11px] items-center justify-between font-semibold text-app-muted mb-2 uppercase tracking-wide">
                <span>Приватный SSH ключ</span>
                <span className="text-app-muted/70 lowercase font-normal italic">(ключ или пароль обязателен)</span>
              </label>
              <textarea name="ssh_key" rows={4} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..." className="w-full bg-app-bg border border-app-border rounded-md px-3 py-3 text-[11px] text-app-text/70 focus:outline-none focus:border-app-accent font-mono resize-none" />
            </div>

            <div>
              <label className="flex text-[11px] items-center justify-between font-semibold text-app-muted mb-2 uppercase tracking-wide">
                <span>SSH пароль</span>
                <span className="text-app-muted/70 lowercase font-normal italic">(ключ или пароль обязателен)</span>
              </label>
              <input name="ssh_password" type="password" autoComplete="new-password" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text/70 focus:outline-none focus:border-app-accent font-mono" />
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Имя сервера</label>
                <input required type="text" name="name" placeholder="RU-Direct-1" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">IPv4 адрес</label>
                <input
                  required
                  type="text"
                  name="ip"
                  placeholder="0.0.0.0"
                  pattern="^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$"
                  className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Роль ноды</label>
                <select name="role" defaultValue="ingress" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono">
                  <option value="ingress">INGRESS</option>
                  <option value="egress">EGRESS</option>
                  <option value="master">MASTER</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">SSH порт</label>
                <input required type="number" min={1} max={65535} defaultValue={22} name="ssh_port" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>

              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">SSH пользователь</label>
                <input required type="text" defaultValue="root" name="ssh_username" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>

              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Inbound группа</label>
                <select name="inbound_tag" defaultValue="IN-RU-DIRECT" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono">
                  {inboundOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Порт inbound</label>
                <input required type="number" min={1} max={65535} defaultValue={443} name="inbound_port" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>

              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">SNI группы</label>
                <input required type="text" name="group_sni" placeholder="example.com" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>

              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Fingerprint</label>
                <input required type="text" name="fingerprint" placeholder="chrome" defaultValue="chrome" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>

              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Дата оплаты</label>
                <input required type="date" name="billing" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" style={{ colorScheme: 'dark' }} />
              </div>
            </div>

            <div>
              <label className="flex text-[11px] items-center justify-between font-semibold text-app-muted mb-2 uppercase tracking-wide">
                <span>Приватный SSH ключ</span>
                <span className="text-app-muted/70 lowercase font-normal italic">(если нет пароля и ключа — ключ сгенерируется)</span>
              </label>
              <textarea name="ssh_key" rows={4} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..." className="w-full bg-app-bg border border-app-border rounded-md px-3 py-3 text-[11px] text-app-text/70 focus:outline-none focus:border-app-accent font-mono resize-none" />
            </div>

            <div>
              <label className="flex text-[11px] items-center justify-between font-semibold text-app-muted mb-2 uppercase tracking-wide">
                <span>SSH пароль</span>
                <span className="text-app-muted/70 lowercase font-normal italic">(можно оставить пустым)</span>
              </label>
              <input name="ssh_password" type="password" autoComplete="new-password" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text/70 focus:outline-none focus:border-app-accent font-mono" />
            </div>
          </>
        )}

        <button
          disabled={loading || (addMode === 'existing' && (marzbanLoading || !selectedMarzbanNode))}
          type="submit"
          className="w-full bg-app-accent text-black font-semibold py-2.5 rounded-md text-[13px] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {loading
            ? addMode === 'new'
              ? 'Деплой и подключение...'
              : 'Импорт Marzban Node...'
            : addMode === 'new'
            ? 'Добавить и задеплоить сервер'
            : 'Импортировать выбранную Marzban Node'}
        </button>
      </form>
    </div>
  );
}

function EditNodeModal({
  node,
  onClose,
  onSuccess,
  onError,
}: {
  node: AppNode;
  onClose: () => void;
  onSuccess: (message: string, partial: boolean) => void;
  onError: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);

    const formData = new FormData(e.currentTarget);
    const sshKeyRaw = String(formData.get('ssh_key') || '');
    const sshPasswordRaw = String(formData.get('ssh_password') || '');

    const payload: any = {
      name: String(formData.get('name') || '').trim(),
      ip: String(formData.get('ip') || '').trim(),
      role: formData.get('role') as NodeRole,
      billing_date: String(formData.get('billing') || '').trim(),
      ssh_username: String(formData.get('ssh_username') || '').trim(),
      ssh_port: Number(formData.get('ssh_port') || 22),
      status: formData.get('status') as NodeStatus,
      inbound_tag: formData.get('inbound_tag') as InboundTag,
      inbound_port: Number(formData.get('inbound_port') || 443),
      group_sni: String(formData.get('group_sni') || '').trim(),
      fingerprint: String(formData.get('fingerprint') || '').trim(),
      reconnect_marzban: formData.get('reconnect_marzban') === 'on',
    };

    if (sshKeyRaw.trim()) {
      payload.ssh_key = sshKeyRaw;
    }
    if (sshPasswordRaw.trim()) {
      payload.ssh_password = sshPasswordRaw;
    }

    const res = await updateNode(node.id, payload);
    setSaving(false);

    if (res.success) {
      onSuccess(res.data?.message || `Параметры сервера ${payload.name} обновлены.`, false);
      return;
    }

    if (res.data?.status === 'partial') {
      onSuccess(res.data?.message || 'Обновление выполнено частично.', true);
      return;
    }

    onError(`Не удалось обновить сервер: ${normalizeError(res.error || 'Неизвестная ошибка')}`);
  };

  return (
    <motion.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button className="absolute inset-0 bg-black/70" onClick={onClose} aria-label="Закрыть" />
      <div className="relative z-10 min-h-screen p-3 md:p-8 flex items-center justify-center">
        <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} className="w-full max-w-2xl bg-app-card border border-app-border rounded-xl">
          <div className="p-4 border-b border-app-border flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold uppercase tracking-wide text-app-muted">Редактирование сервера</div>
              <div className="text-xs text-app-muted mt-1 font-mono">ID #{node.id}</div>
            </div>
            <button onClick={onClose} className="p-1.5 border border-app-border rounded">
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-4 md:p-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Имя</label>
                <input required type="text" name="name" defaultValue={node.name} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">IPv4 адрес</label>
                <input required type="text" name="ip" defaultValue={node.ip} pattern="^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Роль</label>
                <select name="role" defaultValue={node.role} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono">
                  <option value="ingress">INGRESS</option>
                  <option value="egress">EGRESS</option>
                  <option value="master">MASTER</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">SSH порт</label>
                <input required type="number" min={1} max={65535} name="ssh_port" defaultValue={node.ssh_port} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">SSH пользователь</label>
                <input required type="text" name="ssh_username" defaultValue={node.ssh_username || 'root'} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Inbound группа</label>
                <select name="inbound_tag" defaultValue={node.inbound_tag} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono">
                  {inboundOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Inbound порт</label>
                <input required type="number" min={1} max={65535} name="inbound_port" defaultValue={node.inbound_port} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">SNI группы</label>
                <input required type="text" name="group_sni" defaultValue={node.group_sni} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Fingerprint</label>
                <input required type="text" name="fingerprint" defaultValue={node.fingerprint} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Статус</label>
                <select name="status" defaultValue={node.status} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono">
                  <option value="active">active</option>
                  <option value="offline">offline</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Дата оплаты</label>
                <input required type="date" name="billing" defaultValue={node.billing_date} className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono" style={{ colorScheme: 'dark' }} />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-app-text">
              <input type="checkbox" name="reconnect_marzban" className="accent-app-accent" />
              Проверка Marzban и перепривязка группы после сохранения
            </label>

            <div>
              <label className="flex text-[11px] items-center justify-between font-semibold text-app-muted mb-2 uppercase tracking-wide">
                <span>Новый приватный SSH ключ</span>
                <span className="text-app-muted/70 lowercase font-normal italic">(оставьте пустым, чтобы не менять)</span>
              </label>
              <textarea name="ssh_key" rows={4} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..." className="w-full bg-app-bg border border-app-border rounded-md px-3 py-3 text-[11px] text-app-text/70 focus:outline-none focus:border-app-accent font-mono resize-none" />
            </div>

            <div>
              <label className="flex text-[11px] items-center justify-between font-semibold text-app-muted mb-2 uppercase tracking-wide">
                <span>Новый SSH пароль</span>
                <span className="text-app-muted/70 lowercase font-normal italic">(оставьте пустым, чтобы не менять)</span>
              </label>
              <input name="ssh_password" type="password" autoComplete="new-password" className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text/70 focus:outline-none focus:border-app-accent font-mono" />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button type="button" onClick={onClose} className="w-full border border-app-border text-app-text font-semibold py-2.5 rounded-md text-[13px]">
                Отмена
              </button>
              <button disabled={saving} type="submit" className="w-full bg-app-accent text-black font-semibold py-2.5 rounded-md text-[13px] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Pencil className="w-4 h-4" />}
                {saving ? 'Сохранение...' : 'Сохранить изменения'}
              </button>
            </div>
          </form>
        </motion.div>
      </div>
    </motion.div>
  );
}

function HAProxyForm({ nodes }: { nodes: AppNode[] }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; msg: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);

    const formData = new FormData(e.currentTarget);
    const ip = String(formData.get('ip') || '');
    const config = String(formData.get('config') || '');

    const res = await applyHAProxyConfig(ip, config);
    setLoading(false);

    if (res.success) {
      setResult({ success: true, msg: 'Конфигурация успешно проверена и задеплоена.' });
    } else {
      setResult({ success: false, msg: normalizeError(res.error || 'Ошибка деплоя конфигурации') });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col flex-1 bg-app-card border border-app-border rounded-lg overflow-hidden max-h-[80vh]">
      <div className="p-4 border-b border-app-border flex flex-col md:flex-row md:justify-between md:items-center gap-3 shrink-0">
        <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Конфигурация HAProxy</span>
        <div className="flex items-center gap-2 md:gap-3">
          <select name="ip" required className="flex-1 bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs text-app-text focus:outline-none focus:border-app-accent appearance-none font-mono min-w-0 md:min-w-[280px]" defaultValue="">
            <option value="" disabled hidden>
              Выберите целевой сервер...
            </option>
            {nodes.map((n) => (
              <option key={n.id} value={n.ip}>
                {n.name} • {n.ip}:{n.ssh_port}
              </option>
            ))}
          </select>
          <button disabled={loading} type="submit" className="px-3 md:px-4 py-1.5 bg-app-accent text-black font-semibold rounded text-[12px] hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-1.5 cursor-pointer">
            {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Settings2 className="w-3.5 h-3.5" />}
            Применить
          </button>
        </div>
      </div>

      {result && (
        <div className={`px-4 py-2 text-[11px] font-mono flex items-center gap-2 border-b ${result.success ? 'bg-app-success/10 border-app-success/20 text-app-success' : 'bg-app-danger/10 border-app-danger/20 text-app-danger'}`}>
          {result.success ? <ShieldCheck className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
          {result.msg}
        </div>
      )}

      <div className="flex-1 bg-[#050505] p-3 flex flex-col relative">
        <textarea name="config" required placeholder="global&#10;  log /dev/log local0&#10;  tune.ssl.default-dh-param 2048&#10;..." className="w-full flex-1 bg-transparent text-[#A5D6FF] focus:outline-none font-mono text-[12px] resize-none leading-[1.6]" />
      </div>
      <div className="p-4 border-t border-app-border shrink-0">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-app-muted mb-2">Статус редактора</div>
        <div className="text-app-success text-[12px] flex items-center gap-2 font-mono">
          <Network className="w-3.5 h-3.5" />
          Проверка синтаксиса и безопасный деплой с откатом активны.
        </div>
      </div>
    </form>
  );
}
