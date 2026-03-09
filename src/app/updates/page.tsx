'use client';

import { useEffect, useState } from 'react';

interface VersionInfo {
  current: {
    commit: string;
    message: string;
    date: string;
    branch: string;
  };
  remote?: {
    commit: string;
    message: string;
  };
  updateAvailable: boolean;
  commitsBehind: number;
  error?: string;
}

interface UpdateStep {
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
}

const STEP_LABELS: Record<string, string> = {
  pull: 'Git Pull',
  install: 'npm install',
  build: 'Build',
  restart: 'Restart',
};

export default function UpdatesPage() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [steps, setSteps] = useState<UpdateStep[]>([]);
  const [error, setError] = useState('');

  async function checkForUpdates() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/update');
      if (!res.ok) {
        setError(`Server error: ${res.status}`);
        setLoading(false);
        return;
      }
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      }
      setVersion(data);
    } catch {
      setError('Could not check for updates');
    }
    setLoading(false);
  }

  useEffect(() => {
    checkForUpdates();
  }, []);

  async function startUpdate() {
    setUpdating(true);
    setSteps([]);
    setError('');

    let updateSucceeded = false;

    try {
      const res = await fetch('/api/update', { method: 'POST' });
      if (!res.ok) {
        setError(`Update failed: ${res.status}`);
        setUpdating(false);
        return;
      }
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        setError('No response stream');
        setUpdating(false);
        return;
      }

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const step: UpdateStep = JSON.parse(line);
            setSteps(prev => {
              const existing = prev.findIndex(s => s.step === step.step);
              if (existing >= 0) {
                const updated = [...prev];
                updated[existing] = step;
                return updated;
              }
              return [...prev, step];
            });
          } catch {}
        }
      }
      updateSucceeded = true;
    } catch {
      // Connection lost = server is restarting (expected)
      updateSucceeded = true;
      setSteps(prev => {
        const hasRestart = prev.some(s => s.step === 'restart');
        if (!hasRestart) {
          return [...prev, { step: 'restart', status: 'done', message: 'Server is restarting...' }];
        }
        return prev;
      });
    }

    if (updateSucceeded) {
      setTimeout(() => {
        window.location.reload();
      }, 5000);
    } else {
      setUpdating(false);
    }
  }

  function formatDate(dateStr: string) {
    try {
      return new Date(dateStr).toLocaleString('de-DE');
    } catch {
      return dateStr;
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">Updates</h2>
        <button
          onClick={checkForUpdates}
          disabled={loading || updating}
          className="btn-secondary text-sm"
        >
          {loading ? 'Checking...' : 'Check for Updates'}
        </button>
      </div>

      {error && (
        <div className="card mb-6 border-red-500/30">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Current Version */}
      {version?.current && (
        <div className="card mb-6">
          <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">Current Version</h3>
          <div className="grid grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-[#666]">Commit</p>
              <p className="text-sm font-mono">{version.current.commit}</p>
            </div>
            <div>
              <p className="text-xs text-[#666]">Branch</p>
              <p className="text-sm">{version.current.branch}</p>
            </div>
            <div>
              <p className="text-xs text-[#666]">Message</p>
              <p className="text-sm">{version.current.message}</p>
            </div>
            <div>
              <p className="text-xs text-[#666]">Date</p>
              <p className="text-sm">{formatDate(version.current.date)}</p>
            </div>
          </div>
        </div>
      )}

      {/* Update Status */}
      {version && !loading && (
        <div className="card mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-[#a0a0a0] mb-2">Update Status</h3>
              {version.updateAvailable ? (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-claude-500 animate-pulse" />
                    <span className="text-sm text-claude-400">
                      {version.commitsBehind} new commit{version.commitsBehind > 1 ? 's' : ''} available
                    </span>
                  </div>
                  {version.remote && (
                    <p className="text-xs text-[#666]">
                      Latest: <span className="font-mono">{version.remote.commit}</span> — {version.remote.message}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-sm text-green-400">Up to date</span>
                </div>
              )}
            </div>

            {version.updateAvailable && (
              <button
                onClick={startUpdate}
                disabled={updating}
                className="btn-primary text-sm"
              >
                {updating ? 'Updating...' : 'Install Update'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Update Progress */}
      {steps.length > 0 && (
        <div className="card mb-6">
          <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">Update Progress</h3>
          <div className="space-y-3">
            {steps.map((step) => (
              <div key={step.step} className="flex items-start gap-3">
                <div className="mt-0.5">
                  {step.status === 'running' && (
                    <span className="w-4 h-4 rounded-full border-2 border-claude-500 border-t-transparent animate-spin inline-block" />
                  )}
                  {step.status === 'done' && (
                    <span className="text-green-500 text-sm">✓</span>
                  )}
                  {step.status === 'error' && (
                    <span className="text-red-500 text-sm">✗</span>
                  )}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">{STEP_LABELS[step.step] || step.step}</p>
                  <p className={`text-xs mt-0.5 ${
                    step.status === 'error' ? 'text-red-400' : 'text-[#666]'
                  }`}>
                    {step.message}
                  </p>
                </div>
              </div>
            ))}

            {steps.some(s => s.step === 'restart' && s.status === 'done') && (
              <div className="mt-4 p-3 rounded-lg bg-claude-500/10 border border-claude-500/20">
                <p className="text-sm text-claude-400">
                  Server startet neu — Seite wird automatisch neu geladen...
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* How to use */}
      <div className="card">
        <h3 className="text-sm font-semibold text-[#a0a0a0] mb-3">Hinweise</h3>
        <ul className="space-y-2 text-xs text-[#666]">
          <li>• Starte den Server mit <span className="font-mono text-[#888]">./start.sh</span> statt <span className="font-mono text-[#888]">npm start</span> damit der Auto-Restart nach Updates funktioniert.</li>
          <li>• Updates werden von <span className="font-mono text-[#888]">github.com/MariusGFP/pr-security-first-scan-claude-api</span> gezogen.</li>
          <li>• Nach dem Update wird automatisch <span className="font-mono text-[#888]">npm install</span> und <span className="font-mono text-[#888]">npm run build</span> ausgeführt.</li>
        </ul>
      </div>
    </div>
  );
}
