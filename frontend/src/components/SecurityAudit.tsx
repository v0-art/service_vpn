import React, { useEffect, useState } from 'react';
import { Ban, History } from 'lucide-react';
import { fetchSecurityAudit } from '../api';

export function SecurityAudit() {
  const [data, setData] = useState<{ banned_ips: any[]; ssh_logins: any[] } | null>(null);

  useEffect(() => {
    fetchSecurityAudit().then(setData);
  }, []);

  if (!data) {
    return <div className="text-app-muted text-xs font-mono uppercase tracking-widest p-8 text-center">Загрузка аудита безопасности...</div>;
  }

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto w-full pt-4 h-full">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
        <div className="bg-app-card border border-app-border rounded-lg flex flex-col flex-1 min-h-[300px]">
          <div className="p-4 border-b border-app-border flex items-center gap-2 shrink-0">
            <Ban className="w-4 h-4 text-app-danger" />
            <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Текущие блокировки UFW</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr>
                  <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border bg-app-bg/50">IP адрес</th>
                  <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border bg-app-bg/50">Время / Причина</th>
                </tr>
              </thead>
              <tbody>
                {data.banned_ips.map((ban, idx) => (
                  <tr key={idx} className="hover:bg-app-danger/5 transition-colors">
                    <td className="p-4 border-b border-app-border text-[13px] font-mono text-app-danger">{ban.ip}</td>
                    <td className="p-4 border-b border-app-border">
                      <div className="text-[12px] font-mono text-app-text">{ban.date}</div>
                      <div className="text-[11px] text-app-muted mt-1">{ban.reason}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-app-card border border-app-border rounded-lg flex flex-col flex-1 min-h-[300px]">
          <div className="p-4 border-b border-app-border flex items-center gap-2 shrink-0">
            <History className="w-4 h-4 text-app-muted" />
            <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Последние SSH входы</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr>
                  <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border bg-app-bg/50">Событие</th>
                  <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border bg-app-bg/50">Нода / Время</th>
                </tr>
              </thead>
              <tbody>
                {data.ssh_logins.map((login, idx) => (
                  <tr key={idx} className="hover:bg-app-text/5 transition-colors">
                    <td className="p-4 border-b border-app-border">
                      <div className="flex items-center gap-2">
                        {login.status === 'Accepted' ? (
                          <span className="text-app-success font-semibold uppercase tracking-wider text-[10px] bg-app-success/10 px-1.5 py-0.5 border border-app-success/20 rounded">Успех</span>
                        ) : (
                          <span className="text-app-danger font-semibold uppercase tracking-wider text-[10px] bg-app-danger/10 px-1.5 py-0.5 border border-app-danger/20 rounded">Отказ</span>
                        )}
                        <span className="font-mono text-[12px] text-app-text">{login.ip}</span>
                      </div>
                    </td>
                    <td className="p-4 border-b border-app-border">
                      <div className="text-[12px] font-mono text-app-accent">{login.target}</div>
                      <div className="text-[11px] text-app-muted mt-1 font-mono">{login.date}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
