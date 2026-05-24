import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  fetchNodes,
  addNode,
  applyHAProxyConfig,
  isTelegramContext,
  fetchSystemOverview,
} from './api';
import { Node as AppNode, NodeConnectionStatus, SystemOverview } from './types';
import { MarzbanStats } from './components/MarzbanStats';
import { SecurityAudit } from './components/SecurityAudit';
import { SystemLogs } from './components/SystemLogs';
import {
  Server,
  Plus,
  RefreshCw,
  AlertCircle,
  ShieldCheck,
  Settings2,
  Lock,
  Activity,
  Terminal,
  CheckCircle2,
  XCircle,
  Network,
} from 'lucide-react';

type Tab = 'inventory' | 'deploy' | 'haproxy' | 'marzban' | 'security' | 'logs';

type Banner = {
  type: 'success' | 'error' | 'info';
  text: string;
};

const roleLabels: Record<AppNode['role'], string> = {
  master: 'MASTER',
  ingress: 'INGRESS',
  egress: 'EGRESS',
};

const connectionTextByStatus: Record<string, string> = {
  active: 'Активен',
  offline: 'Оффлайн',
};

function normalizeError(error: string): string {
  return error.replace(/^Error:\s*/i, '').trim();
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('inventory');
  const [nodes, setNodes] = useState<AppNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [overview, setOverview] = useState<SystemOverview | null>(null);

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

  const refreshAll = async () => {
    await Promise.all([loadNodes(), loadOverview()]);
  };

  useEffect(() => {
    // @ts-ignore
    const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
    tg?.ready?.();
    tg?.expand?.();

    if (!inTelegram) {
      setWarning('404 Not Found');
      return;
    }

    setWarning(null);
    refreshAll();
  }, [inTelegram]);

  const connectionByIp = useMemo(() => {
    const map = new Map<string, NodeConnectionStatus>();
    for (const node of overview?.nodes || []) {
      map.set(node.ip, node);
    }
    return map;
  }, [overview]);

  const apiStateLabel = inTelegram ? 'Контекст Telegram OK' : 'Только Telegram';
  const marzbanConnected = Boolean(overview?.marzban_connected);
  const sshReachable = overview?.ssh_reachable ?? 0;
  const activeNodesCount = overview?.nodes_active ?? 0;

  if (!inTelegram) {
    return (
      <div className="min-h-screen w-full bg-app-bg text-app-text flex items-center justify-center">
        <div className="bg-app-card border border-app-border rounded-lg p-8 text-center max-w-md">
          <div className="text-5xl font-extrabold text-app-danger mb-3">404</div>
          <div className="text-sm font-semibold mb-2">Страница не найдена</div>
          <div className="text-xs text-app-muted">
            Панель открывается только через кнопку в Telegram-боте.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-app-bg text-app-text">
      <aside className="w-[220px] shrink-0 border-r border-app-border flex flex-col bg-app-card/50">
        <div className="p-6 border-b border-app-border">
          <div className="font-extrabold text-[18px] tracking-[1px] flex items-center gap-2.5 text-app-accent">
            <div className="w-6 h-6 bg-app-accent rounded-sm flex items-center justify-center">
              <ShieldCheck className="w-4 h-4 text-app-bg" />
            </div>
            LUFFY TOWER
          </div>
        </div>
        <nav className="py-4 flex-grow flex flex-col gap-1">
          <button
            onClick={() => setActiveTab('inventory')}
            className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm cursor-pointer transition-colors ${
              activeTab === 'inventory'
                ? 'text-app-text bg-app-accent/10 border-r-[3px] border-app-accent'
                : 'text-app-muted hover:text-app-text'
            }`}
          >
            <Server className="w-4 h-4" /> Инвентарь серверов
          </button>
          <button
            onClick={() => setActiveTab('deploy')}
            className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm cursor-pointer transition-colors ${
              activeTab === 'deploy'
                ? 'text-app-text bg-app-accent/10 border-r-[3px] border-app-accent'
                : 'text-app-muted hover:text-app-text'
            }`}
          >
            <Plus className="w-4 h-4" /> Добавить сервер
          </button>
          <button
            onClick={() => setActiveTab('haproxy')}
            className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm cursor-pointer transition-colors ${
              activeTab === 'haproxy'
                ? 'text-app-text bg-app-accent/10 border-r-[3px] border-app-accent'
                : 'text-app-muted hover:text-app-text'
            }`}
          >
            <Settings2 className="w-4 h-4" /> Конфиг HAProxy
          </button>
          <button
            onClick={() => setActiveTab('marzban')}
            className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm cursor-pointer transition-colors ${
              activeTab === 'marzban'
                ? 'text-app-text bg-app-accent/10 border-r-[3px] border-app-accent'
                : 'text-app-muted hover:text-app-text'
            }`}
          >
            <Activity className="w-4 h-4" /> Marzban
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm cursor-pointer transition-colors ${
              activeTab === 'security'
                ? 'text-app-text bg-app-accent/10 border-r-[3px] border-app-accent'
                : 'text-app-muted hover:text-app-text'
            }`}
          >
            <ShieldCheck className="w-4 h-4" /> Безопасность
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`w-full text-left px-6 py-3 flex items-center gap-3 text-sm cursor-pointer transition-colors ${
              activeTab === 'logs'
                ? 'text-app-text bg-app-accent/10 border-r-[3px] border-app-accent'
                : 'text-app-muted hover:text-app-text'
            }`}
          >
            <Terminal className="w-4 h-4" /> Системные логи
          </button>
        </nav>
        <div className="p-6 border-t border-app-border">
          <div className="text-[10px] text-app-muted mb-2 font-semibold tracking-wider uppercase">Панель администратора</div>
          <div className="text-xs font-mono">Режим: ADMIN</div>
          <div className="text-app-success text-[10px] mt-1.5 flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-app-success" />
            {inTelegram ? 'Подключено через Telegram' : 'Вне Telegram'}
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <div className="h-16 border-b border-app-border flex items-center justify-between px-6 bg-app-card shrink-0">
          <div className="flex gap-3 text-xs font-mono flex-wrap">
            <StatusBadge
              label="API"
              loading={overviewLoading}
              ok={inTelegram}
              okText={apiStateLabel}
              badText="Откройте через бота"
            />
            <StatusBadge
              label="Marzban"
              loading={overviewLoading}
              ok={marzbanConnected}
              okText={`Подключен • ${overview?.marzban_users_count ?? 0} юзеров`}
              badText={overview?.marzban_error || 'Нет соединения'}
            />
            <StatusBadge
              label="SSH"
              loading={overviewLoading}
              ok={sshReachable > 0 || activeNodesCount === 0}
              okText={`${sshReachable}/${activeNodesCount} доступно`}
              badText="Нет доступных серверов"
            />
            <StatusBadge
              label="Серверы"
              loading={overviewLoading}
              ok={(overview?.nodes_total ?? 0) > 0}
              okText={`Всего: ${overview?.nodes_total ?? 0}`}
              badText="Инвентарь пуст"
            />
          </div>
          <div className="flex gap-3">
            <button
              onClick={refreshAll}
              className="px-4 py-2 border border-app-border rounded-md text-xs font-semibold cursor-pointer transition-opacity hover:opacity-80 flex items-center gap-2 text-app-text"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading || overviewLoading ? 'animate-spin' : ''}`} /> Обновить
            </button>
            <button
              onClick={() => setActiveTab('deploy')}
              className="px-4 py-2 bg-app-accent text-black rounded-md text-xs font-semibold cursor-pointer transition-opacity hover:opacity-80"
            >
              + Новый сервер
            </button>
          </div>
        </div>

        <div className="p-5 flex-grow overflow-y-auto">
          {warning && (
            <div className="mb-4 border border-app-danger/40 bg-app-danger/10 text-app-danger rounded-lg p-3 text-xs font-mono">
              {warning}
            </div>
          )}

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
              <motion.div
                key="inventory"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col h-full"
              >
                <div className="bg-app-card border border-app-border rounded-lg flex flex-col flex-1 pb-2">
                  <div className="p-4 border-b border-app-border flex justify-between items-center shrink-0">
                    <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Инвентарь серверов</span>
                    <span className="text-xs text-app-muted font-mono">Всего: {nodes.length}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr>
                          <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">IP адрес</th>
                          <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Роль</th>
                          <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">SSH порт</th>
                          <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Оплата</th>
                          <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Ключ</th>
                          <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Соединение</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loading ? (
                          <tr>
                            <td colSpan={6} className="p-8 text-center text-app-muted text-xs font-mono uppercase tracking-widest">
                              Загрузка серверов...
                            </td>
                          </tr>
                        ) : nodes.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="p-8 text-center text-app-muted text-xs font-mono uppercase tracking-widest">
                              Серверы еще не добавлены
                            </td>
                          </tr>
                        ) : (
                          nodes.map((node) => (
                            <NodeRow key={node.id} node={node} connection={connectionByIp.get(node.ip)} />
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'deploy' && (
              <motion.div
                key="deploy"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col h-full max-w-2xl mx-auto w-full pt-8"
              >
                <DeployForm
                  onSuccess={async (message) => {
                    setBanner({
                      type: 'success',
                      text: message || 'Сервер успешно добавлен.',
                    });
                    await refreshAll();
                    setActiveTab('inventory');
                  }}
                  onError={(message) => {
                    setBanner({ type: 'error', text: message });
                  }}
                />
              </motion.div>
            )}

            {activeTab === 'haproxy' && (
              <motion.div
                key="haproxy"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col h-full max-w-3xl mx-auto w-full pt-4"
              >
                <HAProxyForm nodes={nodes} />
              </motion.div>
            )}

            {activeTab === 'marzban' && (
              <motion.div
                key="marzban"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col h-full w-full"
              >
                <MarzbanStats />
              </motion.div>
            )}

            {activeTab === 'security' && (
              <motion.div
                key="security"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col h-full w-full"
              >
                <SecurityAudit />
              </motion.div>
            )}

            {activeTab === 'logs' && (
              <motion.div
                key="logs"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col h-full w-full"
              >
                <SystemLogs nodes={nodes} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
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
    <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-app-bg border border-app-border">
      {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : ok ? <CheckCircle2 className="w-3.5 h-3.5 text-app-success" /> : <XCircle className="w-3.5 h-3.5 text-app-danger" />}
      {label} <span className={`font-semibold ${ok ? 'text-app-success' : 'text-app-danger'}`}>{ok ? okText : badText}</span>
    </div>
  );
}

const NodeRow: React.FC<{ node: AppNode; connection?: NodeConnectionStatus }> = ({ node, connection }) => {
  const connectivityLabel = (() => {
    if (!connection) {
      return {
        className: 'bg-app-warning/10 text-app-warning',
        text: 'Ожидание проверки',
      };
    }

    if (!connection.checked) {
      return {
        className: 'bg-app-border/20 text-app-muted',
        text: connectionTextByStatus[node.status] || 'Неактивен',
      };
    }

    if (connection.connected) {
      return {
        className: 'bg-app-success/10 text-app-success',
        text: 'SSH доступен',
      };
    }

    return {
      className: 'bg-app-danger/10 text-app-danger',
      text: 'SSH недоступен',
    };
  })();

  return (
    <tr className="hover:bg-app-text/5 transition-colors group relative">
      <td className="p-4 border-b border-app-border text-[13px]">
        <span className="font-mono text-app-accent font-medium">{node.ip}</span>
      </td>
      <td className="p-4 border-b border-app-border text-[13px]">
        <span className="opacity-80">{roleLabels[node.role]}</span>
      </td>
      <td className="p-4 border-b border-app-border text-[13px] font-mono opacity-80">{node.ssh_port}</td>
      <td className="p-4 border-b border-app-border text-[13px] font-mono opacity-80">{node.billing_date}</td>
      <td className="p-4 border-b border-app-border text-[13px]">
        {node.has_ssh_key ? (
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-app-accent/80 group-hover:text-app-accent transition-colors">
            <Lock className="w-3 h-3" />
            <span>Ключ загружен</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-app-warning">
            <AlertCircle className="w-3 h-3" />
            <span>Ключ отсутствует</span>
          </div>
        )}
      </td>
      <td className="p-4 border-b border-app-border text-[13px]">
        <span className={`px-2 py-1 rounded text-[11px] font-bold uppercase tracking-wider ${connectivityLabel.className}`}>
          {connectivityLabel.text}
        </span>
      </td>
    </tr>
  );
};

function DeployForm({ onSuccess, onError }: { onSuccess: (message: string) => void; onError: (message: string) => void }) {
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const payload = {
      ip: String(formData.get('ip') || '').trim(),
      role: formData.get('role') as 'master' | 'ingress' | 'egress',
      billing_date: String(formData.get('billing') || '').trim(),
      ssh_port: Number(formData.get('ssh_port') || 2222),
      ssh_key: (formData.get('ssh_key') as string) || undefined,
    };

    const res = await addNode(payload);
    setLoading(false);

    if (res.success) {
      e.currentTarget.reset();
      onSuccess(res.data?.message || `Сервер ${payload.ip}:${payload.ssh_port} добавлен.`);
      return;
    }

    onError(`Не удалось добавить сервер: ${normalizeError(res.error || 'Неизвестная ошибка')}`);
  };

  return (
    <div className="bg-app-card border border-app-border rounded-lg flex flex-col">
      <div className="p-4 border-b border-app-border">
        <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Добавление сервера в инвентарь</span>
      </div>
      <form onSubmit={handleSubmit} className="p-6 space-y-6">
        <div className="space-y-4">
          <div>
            <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">IPv4 адрес</label>
            <input
              required
              type="text"
              name="ip"
              placeholder="0.0.0.0"
              pattern="^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$"
              className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono transition-colors"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Роль</label>
              <select
                name="role"
                className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent font-mono appearance-none transition-colors"
                defaultValue="ingress"
              >
                <option value="ingress">INGRESS</option>
                <option value="egress">EGRESS</option>
                <option value="master">MASTER</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">SSH порт</label>
              <input
                required
                type="number"
                min={1}
                max={65535}
                defaultValue={2222}
                name="ssh_port"
                className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent transition-colors font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] text-app-muted mb-2 uppercase tracking-wide font-semibold">Дата оплаты</label>
              <input
                required
                type="date"
                name="billing"
                className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-[13px] text-app-text focus:outline-none focus:border-app-accent transition-colors font-mono"
                style={{ colorScheme: 'dark' }}
              />
            </div>
          </div>

          <div>
            <label className="flex text-[11px] items-center justify-between font-semibold text-app-muted mb-2 uppercase tracking-wide">
              <span>Приватный SSH ключ</span>
              <span className="text-app-muted/70 lowercase font-normal italic">(можно оставить пустым — ключ сгенерируется)</span>
            </label>
            <textarea
              name="ssh_key"
              rows={5}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
              className="w-full bg-app-bg border border-app-border rounded-md px-3 py-3 text-[11px] text-app-text/70 focus:outline-none focus:border-app-accent font-mono resize-none transition-colors placeholder:text-app-border"
            />
          </div>
        </div>

        <div className="pt-2">
          <button
            disabled={loading}
            type="submit"
            className="w-full bg-app-accent text-black font-semibold py-2.5 rounded-md text-[13px] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {loading ? 'Добавление...' : 'Добавить сервер'}
          </button>
        </div>
      </form>
    </div>
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
    const ip = formData.get('ip') as string;
    const config = formData.get('config') as string;

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
      <div className="p-4 border-b border-app-border flex justify-between items-center shrink-0">
        <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Конфигурация HAProxy</span>
        <div className="flex items-center gap-3">
          <select
            name="ip"
            required
            className="bg-app-bg border border-app-border rounded flex items-center px-2 py-1.5 text-xs text-app-text focus:outline-none focus:border-app-accent appearance-none font-mono min-w-[220px]"
            defaultValue=""
          >
            <option value="" disabled hidden>
              Выберите целевой сервер...
            </option>
            {nodes
              .filter((n) => n.role === 'ingress')
              .map((n) => (
                <option key={n.id} value={n.ip}>
                  {n.ip}:{n.ssh_port} (INGRESS)
                </option>
              ))}
            {nodes
              .filter((n) => n.role !== 'ingress')
              .map((n) => (
                <option key={n.id} value={n.ip}>
                  {n.ip}:{n.ssh_port} ({roleLabels[n.role]})
                </option>
              ))}
          </select>
          <button
            disabled={loading}
            type="submit"
            className="px-4 py-1.5 bg-app-accent text-black font-semibold rounded text-[12px] hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
          >
            {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Settings2 className="w-3.5 h-3.5" />}
            Проверить и задеплоить
          </button>
        </div>
      </div>

      {result && (
        <div
          className={`px-4 py-2 text-[11px] font-mono flex items-center gap-2 border-b ${
            result.success
              ? 'bg-app-success/10 border-app-success/20 text-app-success'
              : 'bg-app-danger/10 border-app-danger/20 text-app-danger'
          }`}
        >
          {result.success ? <ShieldCheck className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
          {result.msg}
        </div>
      )}

      <div className="flex-1 bg-[#050505] p-3 flex flex-col relative">
        <textarea
          name="config"
          required
          placeholder="global&#10;  log /dev/log local0&#10;  tune.ssl.default-dh-param 2048&#10;..."
          className="w-full flex-1 bg-transparent text-[#A5D6FF] focus:outline-none font-mono text-[12px] resize-none leading-[1.6]"
        />
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
