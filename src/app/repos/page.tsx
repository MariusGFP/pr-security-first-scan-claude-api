'use client';

import { useEffect, useState } from 'react';
import type { Repo } from '@/types';

interface ModelOption {
  key: string;
  name: string;
  context: string;
  costPer1MInput: number;
  costPer1MOutput: number;
}

export default function ReposPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newOrg, setNewOrg] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [scanMenuRepo, setScanMenuRepo] = useState<number | null>(null);
  const [pullingRepo, setPullingRepo] = useState<number | null>(null);

  async function loadRepos() {
    const res = await fetch('/api/repos');
    setRepos(await res.json());
    setLoading(false);
  }

  async function loadModels() {
    try {
      const res = await fetch('/api/scan');
      const data = await res.json();
      setModels(data.models || []);
    } catch { /* ignore */ }
  }

  useEffect(() => { loadRepos(); loadModels(); }, []);

  async function addRepo() {
    if (!newOrg || !newName) return;
    setAdding(true);
    try {
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org: newOrg, name: newName }),
      });
      if (res.ok) {
        setShowAdd(false);
        setNewOrg('');
        setNewName('');
        loadRepos();
      }
    } finally {
      setAdding(false);
    }
  }

  async function pullRepo(repoId: number) {
    setPullingRepo(repoId);
    try {
      const res = await fetch('/api/repos/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(`✅ Pull successful!\n${data.branch}: ${data.commit}`);
      } else {
        alert(`❌ Pull failed: ${data.error}`);
      }
    } catch (e: any) {
      alert(`❌ Pull failed: ${e.message}`);
    } finally {
      setPullingRepo(null);
    }
  }

  async function startScan(repoId: number, model: string) {
    setScanMenuRepo(null);
    await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId, model }),
    });
    alert(`First Scan started with ${models.find(m => m.key === model)?.name || model}! Check Logs for progress.`);
  }

  if (loading) return <div className="text-[#666]">Loading repositories...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">Repositories</h2>
        <button onClick={() => setShowAdd(!showAdd)} className="btn-primary">
          + Add Repo
        </button>
      </div>

      {/* Add Repo Form */}
      {showAdd && (
        <div className="card mb-6">
          <h3 className="text-sm font-semibold mb-4">New Repository</h3>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Organization (e.g. X4Tcom)"
              value={newOrg}
              onChange={e => setNewOrg(e.target.value)}
              className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] focus:border-claude-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Repo name (e.g. ZEHUB-Serendipity)"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] focus:border-claude-500 focus:outline-none"
            />
            <button onClick={addRepo} disabled={adding} className="btn-primary">
              {adding ? 'Adding...' : 'Add'}
            </button>
          </div>
          <p className="text-xs text-[#555] mt-2">
            The repo will be cloned, CLAUDE.md generated, and a webhook created.
          </p>
        </div>
      )}

      {/* Repo List */}
      {repos.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-[#666] mb-2">No repositories found</p>
          <p className="text-xs text-[#555]">Click &quot;Add Repo&quot; above to get started</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {repos.map(repo => (
            <div key={repo.id} className="card-hover">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <a href={`/repos/${repo.id}`} className="text-base font-semibold hover:text-claude-400 transition-colors">
                      {repo.full_name}
                    </a>
                    {repo.monitoring_active ? (
                      <span className="badge-success">Monitoring active</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#333] text-[#888]">
                        Inactive
                      </span>
                    )}
                    {repo.webhook_id && (
                      <span className="text-xs text-[#555]">Webhook #{repo.webhook_id}</span>
                    )}
                  </div>
                  <p className="text-xs text-[#666] mt-1">{repo.local_path} · Base: {repo.base_branch}</p>
                </div>

                <div className="flex gap-2 relative">
                  <button
                    onClick={() => pullRepo(repo.id)}
                    disabled={pullingRepo === repo.id}
                    className="btn-secondary text-sm"
                  >
                    {pullingRepo === repo.id ? '⏳ Pulling...' : '📥 Pull'}
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => setScanMenuRepo(scanMenuRepo === repo.id ? null : repo.id)}
                      className="btn-secondary text-sm"
                    >
                      🔍 First Scan ▾
                    </button>

                    {/* Model Selection Dropdown */}
                    {scanMenuRepo === repo.id && (
                      <div className="absolute right-0 top-full mt-1 bg-[#1a1a1a] border border-[#333] rounded-lg shadow-xl z-50 min-w-[280px]">
                        <div className="px-3 py-2 border-b border-[#333]">
                          <p className="text-xs font-semibold text-[#888]">Select Model</p>
                        </div>
                        {models.map(model => (
                          <button
                            key={model.key}
                            onClick={() => startScan(repo.id, model.key)}
                            className="w-full text-left px-3 py-2.5 hover:bg-[#252525] transition-colors border-b border-[#222] last:border-0"
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium text-white">{model.name}</span>
                              <span className="text-xs text-[#888] bg-[#252525] px-2 py-0.5 rounded">{model.context}</span>
                            </div>
                            <p className="text-xs text-[#666] mt-0.5">
                              ${model.costPer1MInput}/1M input · ${model.costPer1MOutput}/1M output
                            </p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <a href={`/repos/${repo.id}`} className="btn-secondary text-sm">
                    Configure
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
