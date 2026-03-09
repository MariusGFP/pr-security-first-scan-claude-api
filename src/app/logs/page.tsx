'use client';

import { useEffect, useState, useRef } from 'react';

export default function LogsPage() {
  const [logs, setLogs] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadLogs() {
      const res = await fetch('/api/logs');
      const data = await res.json();
      setLogs(data.logs || []);
    }
    loadLogs();
    const interval = setInterval(loadLogs, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  function getLogClass(line: string): string {
    if (line.includes('❌') || line.includes('Fehler')) return 'log-line-error';
    if (line.includes('✅')) return 'log-line-success';
    return 'log-line';
  }

  const filteredLogs = filter
    ? logs.filter(l => l.toLowerCase().includes(filter.toLowerCase()))
    : logs;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Logs</h2>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Filter..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-1.5 text-sm text-white placeholder-[#555] focus:border-claude-500 focus:outline-none w-48"
          />
          <label className="flex items-center gap-2 text-xs text-[#666]">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={e => setAutoScroll(e.target.checked)}
              className="rounded"
            />
            Auto-Scroll
          </label>
          <span className="text-xs text-[#555]">{filteredLogs.length} Einträge</span>
        </div>
      </div>

      <div className="flex-1 card overflow-auto font-mono">
        {filteredLogs.length === 0 ? (
          <p className="text-sm text-[#666] p-4">Keine Logs vorhanden</p>
        ) : (
          filteredLogs.map((line, i) => (
            <div key={i} className={getLogClass(line)}>
              {line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
