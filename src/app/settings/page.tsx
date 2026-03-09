'use client';

import { useEffect, useState } from 'react';

interface KeysData {
  GH_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string;
  AUDITS_DIR: string;
  REPOS_DIR: string;
  hasGhToken: boolean;
  hasAnthropicKey: boolean;
  hasWebhookSecret: boolean;
}

interface TunnelData {
  running: boolean;
  tunnelId: string | null;
  hostname: string | null;
  launchdLoaded: boolean;
  configExists: boolean;
}

interface ServicesData {
  dashboard: { uptime: number; uptimeFormatted: string };
  tunnel: { running: boolean };
  claude: { available: boolean; version: string };
  gh: { available: boolean };
  system: {
    hostname: string;
    cpus: number;
    totalMemory: string;
    freeMemory: string;
    nodeVersion: string;
  };
  services: { name: string; loaded: boolean }[];
}

interface PromptData {
  id: string;
  name: string;
  content: string;
  path: string;
}

export default function SettingsPage() {
  const [keys, setKeys] = useState<KeysData | null>(null);
  const [tunnel, setTunnel] = useState<TunnelData | null>(null);
  const [services, setServices] = useState<ServicesData | null>(null);
  const [prompts, setPrompts] = useState<PromptData[]>([]);
  const [editingPrompt, setEditingPrompt] = useState<PromptData | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Key input states
  const [newGhToken, setNewGhToken] = useState('');
  const [newAnthropicKey, setNewAnthropicKey] = useState('');
  const [newWebhookSecret, setNewWebhookSecret] = useState('');
  const [newAuditsDir, setNewAuditsDir] = useState('');
  const [newReposDir, setNewReposDir] = useState('');

  useEffect(() => {
    Promise.all([
      fetch('/api/keys').then(r => r.json()),
      fetch('/api/tunnel').then(r => r.json()),
      fetch('/api/services').then(r => r.json()),
      fetch('/api/prompts').then(r => r.json()),
    ]).then(([k, t, s, p]) => {
      setKeys(k);
      setTunnel(t);
      setServices(s);
      setPrompts(p);
    });
  }, []);

  function showMessage(msg: string) {
    setMessage(msg);
    setTimeout(() => setMessage(''), 3000);
  }

  async function saveKeys() {
    setSaving(true);
    const body: any = {};
    if (newGhToken) body.GH_TOKEN = newGhToken;
    if (newAnthropicKey) body.ANTHROPIC_API_KEY = newAnthropicKey;
    if (newWebhookSecret) body.WEBHOOK_SECRET = newWebhookSecret;
    if (newAuditsDir) body.AUDITS_DIR = newAuditsDir;
    if (newReposDir) body.REPOS_DIR = newReposDir;

    await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    setNewGhToken('');
    setNewAnthropicKey('');
    setNewWebhookSecret('');
    setNewAuditsDir('');
    setNewReposDir('');
    const updated = await fetch('/api/keys').then(r => r.json());
    setKeys(updated);
    setSaving(false);
    showMessage('Settings saved');
  }

  async function tunnelAction(action: string) {
    await fetch('/api/tunnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const updated = await fetch('/api/tunnel').then(r => r.json());
    setTunnel(updated);
    showMessage(`Tunnel ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'}`);
  }

  async function savePrompt() {
    if (!editingPrompt) return;
    setSaving(true);
    await fetch('/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptPath: editingPrompt.path, content: editContent }),
    });
    const updated = await fetch('/api/prompts').then(r => r.json());
    setPrompts(updated);
    setEditingPrompt(null);
    setSaving(false);
    showMessage('Prompt saved');
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">Settings</h2>
        {message && <span className="text-sm text-green-400">{message}</span>}
      </div>

      {/* System Status */}
      {services && (
        <div className="card mb-6">
          <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">System Status</h3>
          <div className="grid grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-[#666]">Host</p>
              <p className="text-sm">{services.system.hostname}</p>
            </div>
            <div>
              <p className="text-xs text-[#666]">Uptime</p>
              <p className="text-sm">{services.dashboard.uptimeFormatted}</p>
            </div>
            <div>
              <p className="text-xs text-[#666]">CPU / RAM</p>
              <p className="text-sm">{services.system.cpus} Cores · {services.system.freeMemory} free</p>
            </div>
            <div>
              <p className="text-xs text-[#666]">Node</p>
              <p className="text-sm">{services.system.nodeVersion}</p>
            </div>
          </div>
          <div className="mt-4 flex gap-4">
            {services.services.map(svc => (
              <div key={svc.name} className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${svc.loaded ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-xs text-[#888]">{svc.name.replace('com.claude.', '')}</span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${services.claude.available ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs text-[#888]">Claude CLI {services.claude.version}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${services.gh.available ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs text-[#888]">gh CLI</span>
            </div>
          </div>
        </div>
      )}

      {/* Cloudflare Tunnel */}
      {tunnel && (
        <div className="card mb-6">
          <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">Cloudflare Tunnel</h3>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${tunnel.running ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-sm">{tunnel.running ? 'Running' : 'Stopped'}</span>
              </div>
              {tunnel.hostname && <p className="text-xs text-[#555]">Hostname: {tunnel.hostname}</p>}
              {tunnel.tunnelId && <p className="text-xs text-[#555]">Tunnel ID: {tunnel.tunnelId}</p>}
            </div>
            <div className="flex gap-2">
              <button onClick={() => tunnelAction('start')} disabled={tunnel.running} className="btn-secondary text-sm">Start</button>
              <button onClick={() => tunnelAction('stop')} disabled={!tunnel.running} className="btn-secondary text-sm">Stop</button>
              <button onClick={() => tunnelAction('restart')} className="btn-secondary text-sm">Restart</button>
            </div>
          </div>
        </div>
      )}

      {/* API Keys */}
      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">API Keys (~/.keys)</h3>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-[#666] block mb-1">
              GitHub Token (GH_TOKEN) {keys?.hasGhToken && <span className="text-green-500">✓</span>}
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder={keys?.GH_TOKEN || 'ghp_...'}
                value={newGhToken}
                onChange={e => setNewGhToken(e.target.value)}
                className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] focus:border-claude-500 focus:outline-none font-mono"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-[#666] block mb-1">
              Anthropic API Key (ANTHROPIC_API_KEY) {keys?.hasAnthropicKey && <span className="text-green-500">✓</span>}
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder={keys?.ANTHROPIC_API_KEY || 'sk-ant-...'}
                value={newAnthropicKey}
                onChange={e => setNewAnthropicKey(e.target.value)}
                className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] focus:border-claude-500 focus:outline-none font-mono"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-[#666] block mb-1">
              Webhook Secret {keys?.hasWebhookSecret && <span className="text-green-500">✓</span>}
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="••••••••"
                value={newWebhookSecret}
                onChange={e => setNewWebhookSecret(e.target.value)}
                className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] focus:border-claude-500 focus:outline-none font-mono"
              />
            </div>
          </div>
          <button onClick={saveKeys} disabled={saving || (!newGhToken && !newAnthropicKey && !newWebhookSecret && !newAuditsDir && !newReposDir)} className="btn-primary text-sm">
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* Paths Configuration */}
      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">Paths</h3>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-[#666] block mb-1">
              Audit Reports Directory (AUDITS_DIR)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={keys?.AUDITS_DIR || '~/automation/audits'}
                value={newAuditsDir}
                onChange={e => setNewAuditsDir(e.target.value)}
                className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] focus:border-claude-500 focus:outline-none font-mono"
              />
            </div>
            <p className="text-xs text-[#444] mt-1">
              First Scan: {keys?.AUDITS_DIR || '~/automation/audits'}/code-audits/ · Security Scan: {keys?.AUDITS_DIR || '~/automation/audits'}/security-audits/
            </p>
          </div>
          <div>
            <label className="text-xs text-[#666] block mb-1">
              Repositories Directory (REPOS_DIR)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={keys?.REPOS_DIR || '~/repos'}
                value={newReposDir}
                onChange={e => setNewReposDir(e.target.value)}
                className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] focus:border-claude-500 focus:outline-none font-mono"
              />
            </div>
          </div>
          <button onClick={saveKeys} disabled={saving || (!newAuditsDir && !newReposDir)} className="btn-primary text-sm">
            {saving ? 'Saving...' : 'Save Paths'}
          </button>
        </div>
      </div>

      {/* Agent-Prompts */}
      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">Agent Prompts (editable)</h3>

        {editingPrompt ? (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium">{editingPrompt.id} — {editingPrompt.name}</p>
              <div className="flex gap-2">
                <button onClick={savePrompt} disabled={saving} className="btn-primary text-sm">
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditingPrompt(null)} className="btn-secondary text-sm">Cancel</button>
              </div>
            </div>
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="w-full h-96 bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-claude-500 focus:outline-none resize-y"
            />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {prompts.map(prompt => (
              <button
                key={prompt.id}
                onClick={() => { setEditingPrompt(prompt); setEditContent(prompt.content); }}
                className="p-3 rounded-lg bg-[#1a1a1a] hover:bg-[#222] transition-colors text-left"
              >
                <p className="text-xs font-semibold">{prompt.id}</p>
                <p className="text-xs text-[#555] mt-1">{prompt.content.split('\n')[0].replace('#', '').trim()}</p>
                <p className="text-xs text-[#444] mt-1">{prompt.content.split('\n').length} lines</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Thresholds */}
      <div className="card">
        <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">Sub-Agent Thresholds</h3>
        <div className="grid grid-cols-4 gap-4">
          <div className="p-3 rounded bg-[#1a1a1a]">
            <p className="text-xs text-[#666]">Small</p>
            <p className="text-sm">&lt; 500 lines</p>
            <p className="text-xs text-[#555]">9 Agents · ~$0.50</p>
          </div>
          <div className="p-3 rounded bg-[#1a1a1a]">
            <p className="text-xs text-[#666]">Medium</p>
            <p className="text-sm">500–2000 lines</p>
            <p className="text-xs text-[#555]">18 Agents · ~$2-3</p>
          </div>
          <div className="p-3 rounded bg-[#1a1a1a]">
            <p className="text-xs text-[#666]">Large</p>
            <p className="text-sm">2000–5000 lines</p>
            <p className="text-xs text-[#555]">27 Agents · ~$4-6</p>
          </div>
          <div className="p-3 rounded bg-[#1a1a1a]">
            <p className="text-xs text-[#666]">Very Large</p>
            <p className="text-sm">&gt; 5000 lines</p>
            <p className="text-xs text-[#555]">bis 45 Agents · ~$8-12</p>
          </div>
        </div>
      </div>
    </div>
  );
}
