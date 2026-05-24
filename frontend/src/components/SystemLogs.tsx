import React, { useState } from 'react';
import { executeSysinfo } from '../api';
import { TerminalSquare } from 'lucide-react';
import { Node as AppNode } from '../types';

const roleLabels: Record<AppNode['role'], string> = {
  master: 'MASTER',
  ingress: 'INGRESS',
  egress: 'EGRESS',
};

export function SystemLogs({ nodes }: { nodes: AppNode[] }) {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const runCommand = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const ip = formData.get('ip') as string;

    setLoading(true);
    setLogs((prev) => [...prev, `root@tower:~# sysinfo ${ip}`]);

    setTimeout(async () => {
      const result = await executeSysinfo(ip);
      setLogs((prev) => [...prev, ...result]);
      setLoading(false);
    }, 600);
  };

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto w-full pt-4">
      <div className="flex items-center gap-4 mb-4">
        <form onSubmit={runCommand} className="flex gap-2">
          <select
            name="ip"
            required
            className="bg-app-card border border-app-border rounded flex items-center px-3 py-1.5 text-xs text-app-text focus:outline-none focus:border-app-accent font-mono min-w-[220px]"
            defaultValue=""
          >
            <option value="" disabled hidden>
              Выберите сервер...
            </option>
            {nodes.map((n) => (
              <option key={n.id} value={n.ip}>
                {n.ip}:{n.ssh_port} ({roleLabels[n.role]})
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-1.5 bg-app-bg border border-app-border text-app-text font-semibold rounded text-[12px] hover:bg-app-card transition-colors disabled:opacity-50 cursor-pointer"
          >
            Выполнить sysinfo
          </button>
        </form>
        <div className="text-xs text-app-muted flex items-center gap-1.5 ml-auto">
          <TerminalSquare className="w-3.5 h-3.5" /> LUFFY SHELL v1.0
        </div>
      </div>

      <div className="flex-1 bg-[#000] border-t border-x border-app-border rounded-t-lg p-5 font-mono text-[12px] leading-relaxed overflow-y-auto">
        <div className="text-app-muted mb-4">SSH EXECUTOR - LUFFY SHELL v1.0</div>

        {logs.length === 0 && <div className="text-app-muted/50 italic">Выполните команду, чтобы увидеть вывод...</div>}

        <div className="space-y-1">
          {logs.map((logLine, idx) => (
            <div
              key={idx}
              className={`${
                logLine.startsWith('root@tower')
                  ? 'text-app-text mt-3'
                  : logLine.startsWith('[INFO]')
                  ? 'text-app-muted'
                  : logLine.includes('free') || logLine.includes('DISK')
                  ? 'text-app-warning'
                  : 'text-[#D1D5DB]'
              }`}
            >
              {logLine.startsWith('root@tower') ? (
                <>
                  <span className="text-app-success shrink-0">root@tower:~#</span> {logLine.replace('root@tower:~# ', '')}
                </>
              ) : (
                logLine
              )}
            </div>
          ))}
          <div className="mt-2 text-app-text">
            <span className="text-app-success shrink-0">root@tower:~#</span>
            {loading ? (
              <span className="animate-pulse ml-1 opacity-50 block w-2 h-4 bg-app-accent inline-block" />
            ) : (
              <span className="border-l-2 border-app-accent pl-1 ml-1 text-transparent">_</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
