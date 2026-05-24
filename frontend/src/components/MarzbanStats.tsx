import React, { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { fetchMarzbanStats } from '../api';

export function MarzbanStats() {
  const [data, setData] = useState<{ anomalies: any[]; top_users: any[] } | null>(null);

  useEffect(() => {
    fetchMarzbanStats().then(setData);
  }, []);

  if (!data) {
    return <div className="text-app-muted text-xs font-mono uppercase tracking-widest p-8 text-center">Загрузка статистики Marzban...</div>;
  }

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto w-full pt-4 h-full">
      <div className="grid grid-cols-1 gap-6 flex-1">
        <div className="bg-app-card border border-app-border rounded-lg flex flex-col shrink-0">
          <div className="p-4 border-b border-app-border flex items-center gap-2">
            <Activity className="w-4 h-4 text-app-danger" />
            <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Найденные аномалии трафика</span>
          </div>
          <div className="p-4 space-y-3 bg-app-danger/5">
            {data.anomalies.map((a) => (
              <div key={a.id} className="flex flex-col border border-app-danger/20 bg-[#050505]/50 rounded p-3">
                <span className="text-[12px] font-mono text-app-danger">{a.text}</span>
              </div>
            ))}
            {data.anomalies.length === 0 && (
              <div className="text-[12px] text-app-success font-mono font-medium">Аномалии не обнаружены. Система работает стабильно.</div>
            )}
          </div>
        </div>

        <div className="bg-app-card border border-app-border rounded-lg flex flex-col flex-1 pb-2 min-h-0">
          <div className="p-4 border-b border-app-border flex justify-between items-center shrink-0">
            <span className="text-sm font-semibold uppercase tracking-[0.05em] text-app-muted">Топ пользователей по трафику</span>
            <span className="text-xs text-app-muted font-mono">{data.top_users.length} записей</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr>
                  <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Пользователь</th>
                  <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Передано данных</th>
                  <th className="p-4 text-[11px] text-app-muted uppercase font-semibold border-b border-app-border">Статус Marzban</th>
                </tr>
              </thead>
              <tbody>
                {data.top_users.map((user, idx) => (
                  <tr key={idx} className="hover:bg-app-text/5 transition-colors">
                    <td className="p-4 border-b border-app-border text-[13px] font-mono text-app-accent">{user.username}</td>
                    <td className="p-4 border-b border-app-border text-[13px] font-mono text-app-text">{user.traffic}</td>
                    <td className="p-4 border-b border-app-border text-[13px]">
                      {user.status === 'active' ? (
                        <span className="px-2 py-1 bg-app-success/10 text-app-success rounded text-[11px] font-bold uppercase tracking-wider">Активен</span>
                      ) : (
                        <span className="px-2 py-1 bg-app-warning/10 text-app-warning rounded text-[11px] font-bold uppercase tracking-wider">Ограничен</span>
                      )}
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
