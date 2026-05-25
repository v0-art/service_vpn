import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
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
  fetchNodes,
  fetchSystemOverview,
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
  Node as AppNode,
  NodeConnectionStatus,
  NodeCreatePayload,
  NodeRole,
  NodeStatus,
  SystemOverview,
} from './types';

type Tab = 'inventory' | 'deploy' | 'haproxy' | 'marzban' | 'security' | 'logs';

type Banner = {
  type: 'success' | 'error' | 'info';
  text: string;
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
  { tab: 'deploy', label: 'Добавить сервер', icon: Plus },
  { tab: 'haproxy', label: 'HAProxy', icon: Settings2 },
  { tab: 'marzban', label: 'Marzban', icon: Activity },
  { tab: 'security', label: 'Безопасность', icon: ShieldCheck },
  { tab: 'logs', label: 'Логи', icon: Terminal },
];

function normalizeError(error: string): string {
  return error.replace(/^Error:\s*/i, '').trim();
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

  const connectionByIp = useMemo(() => {
    const map = new Map<string, NodeConnectionStatus>();
    for (const node of overview?.nodes || []) {
      map.set(node.ip, node);
    }
    return map;
  }, [overview]);

  const marzbanConnected = Boolean(marzbanConn?.connected ?? overview?.marzban_connected);

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

  const handleDeleteNode = async (node: AppNode) => {
    const ok = window.confirm(
      `Удалить сервер \"${node.name}\" (${node.ip})?\n\nБудет удален из панели, из Marzban и выполнится cleanup на ноде по SSH.`
    );
    if (!ok) {
      return;
    }

    const res = await deleteNode(node.id, true);
    if (res.success) {
      setBanner({ type: 'success', text: res.data?.message || `Сервер ${node.name} удален.` });
      await refreshAll();
      return;
    }

    setBanner({ type: 'error', text: `Не удалось удалить сервер: ${normalizeError(res.error || 'неизвестная ошибка')}` });
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
                ok={(overview?.ssh_reachable || 0) > 0 || (overview?.nodes_active || 0) === 0}
                okText={`${overview?.ssh_reachable ?? 0}/${overview?.nodes_active ?? 0}`}
                badText="недоступно"
              />
              <StatusBadge
                label="Серверы"
                loading={overviewLoading}
                ok={(overview?.nodes_total ?? 0) > 0}
                okText={`${overview?.nodes_total ?? 0}`}
                badText="пусто"
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
              <div className="mt-2 text-xs text-app-muted">Роль: {roleLabels[node.role]}</div>
              <div className="mt-1 text-xs text-app-muted">Inbound: {node.inbound_tag}</div>
              <div className="mt-1 text-xs text-app-muted">SNI/порт: {node.group_sni}:{node.inbound_port}</div>
              <div className="mt-1 text-xs text-app-muted">Ключ: {node.has_ssh_key ? 'загружен' : 'отсутствует'}</div>

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
  return (
    <tr className="hover:bg-app-text/5 transition-colors group relative">
      <td className="p-4 border-b border-app-border text-[13px] font-semibold">{node.name}</td>
      <td className="p-4 border-b border-app-border text-[13px]">
        <span className="font-mono text-app-accent font-medium">{node.ip}</span>
      </td>
      <td className="p-4 border-b border-app-border text-[13px]">
        <span className="opacity-80">{roleLabels[node.role]}</span>
      </td>
      <td className="p-4 border-b border-app-border text-[13px] font-mono opacity-80">
        {node.ssh_port}
        <div className="mt-1 text-[10px]">
          {node.has_ssh_key ? (
            <span className="inline-flex items-center gap-1 text-app-success"><Lock className="w-3 h-3" /> ключ OK</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-app-warning"><AlertCircle className="w-3 h-3" /> ключ отсутствует</span>
          )}
        </div>
      </td>
      <td className="p-4 border-b border-app-border text-[12px] font-mono">{node.inbound_tag}</td>
      <td className="p-4 border-b border-app-border text-[12px] font-mono">{node.group_sni}:{node.inbound_port}</td>
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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const payload: NodeCreatePayload = {
      name: String(formData.get('name') || '').trim(),
      ip: String(formData.get('ip') || '').trim(),
      role: formData.get('role') as NodeRole,
      billing_date: String(formData.get('billing') || '').trim(),
      ssh_port: Number(formData.get('ssh_port') || 22),
      ssh_key: (formData.get('ssh_key') as string) || undefined,
      inbound_tag: formData.get('inbound_tag') as InboundTag,
      inbound_port: Number(formData.get('inbound_port') || 443),
      group_sni: String(formData.get('group_sni') || '').trim(),
      fingerprint: String(formData.get('fingerprint') || '').trim(),
      is_new_server: formData.get('is_new_server') === 'on',
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

        <label className="flex items-center gap-2 text-sm text-app-text">
          <input type="checkbox" name="is_new_server" className="accent-app-accent" />
          Сервер новый (установить ufw/fail2ban/docker/marzban-node и мониторинг автоматически)
        </label>

        <div>
          <label className="flex text-[11px] items-center justify-between font-semibold text-app-muted mb-2 uppercase tracking-wide">
            <span>Приватный SSH ключ</span>
            <span className="text-app-muted/70 lowercase font-normal italic">(можно оставить пустым — ключ сгенерируется)</span>
          </label>
          <textarea name="ssh_key" rows={4} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..." className="w-full bg-app-bg border border-app-border rounded-md px-3 py-3 text-[11px] text-app-text/70 focus:outline-none focus:border-app-accent font-mono resize-none" />
        </div>

        <button
          disabled={loading}
          type="submit"
          className="w-full bg-app-accent text-black font-semibold py-2.5 rounded-md text-[13px] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {loading ? 'Добавление и настройка...' : 'Добавить сервер'}
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

    const payload: any = {
      name: String(formData.get('name') || '').trim(),
      ip: String(formData.get('ip') || '').trim(),
      role: formData.get('role') as NodeRole,
      billing_date: String(formData.get('billing') || '').trim(),
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
