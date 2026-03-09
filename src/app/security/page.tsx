'use client';

import { useEffect, useState } from 'react';

interface SecurityScan {
  id: number;
  platform_name: string;
  repos_dir: string;
  status: string;
  model: string;
  total_agents: number;
  duration_seconds: number | null;
  architecture_map: string | null;
  agent_results: string | null;
  full_report: string | null;
  report: string | null;
  report_file: string | null;
  estimated_cost: number | null;
  created_at: string;
  completed_at: string | null;
}

interface SecurityRepo {
  id: number;
  platform_name: string;
  local_path: string;
  repo_name: string;
  branch: string;
  source: string;
  github_url: string | null;
  added_at: string;
}

interface ModelOption {
  key: string;
  name: string;
  context: string;
  costPer1MInput: number;
  costPer1MOutput: number;
}

export default function SecurityPage() {
  const [scans, setScans] = useState<SecurityScan[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [repos, setRepos] = useState<SecurityRepo[]>([]);
  const [platforms, setPlatforms] = useState<Record<string, SecurityRepo[]>>({});
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  // Form state
  const [platformName, setPlatformName] = useState('');
  const [selectedModel, setSelectedModel] = useState('opus');
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<number>>(new Set());

  // Add repo form
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [addMode, setAddMode] = useState<'local' | 'github'>('local');
  const [newRepoPath, setNewRepoPath] = useState('');
  const [newGithubUrl, setNewGithubUrl] = useState('');
  const [newRepoPlatform, setNewRepoPlatform] = useState('');
  const [newRepoBranch, setNewRepoBranch] = useState('main');
  const [addingRepo, setAddingRepo] = useState(false);

  // View state
  const [viewingScan, setViewingScan] = useState<SecurityScan | null>(null);

  // Chat state
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [reportTab, setReportTab] = useState<'report' | 'architecture' | 'agents' | 'coverage' | 'diff'>('report');
  const [reportMode, setReportMode] = useState<'summary' | 'full'>('summary');
  const [diffResult, setDiffResult] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Freshness check state
  const [checkingFreshness, setCheckingFreshness] = useState(false);
  const [freshnessResults, setFreshnessResults] = useState<Array<{
    path: string;
    name: string;
    upToDate: boolean;
    behind: number;
    branch: string;
    localCommit: string;
    remoteCommit: string;
    error?: string;
  }> | null>(null);
  const [updatingRepos, setUpdatingRepos] = useState(false);

  async function loadDiff() {
    if (!viewingScan || diffLoading) return;
    // Find previous completed scan for same platform
    const samePlatform = scans
      .filter(s => s.platform_name === viewingScan.platform_name && s.status === 'completed' && s.id < viewingScan.id)
      .sort((a, b) => b.id - a.id);
    if (samePlatform.length === 0) {
      setDiffResult('No previous audit found for this platform. Run at least 2 scans to compare.');
      return;
    }
    setDiffLoading(true);
    setDiffResult(null);
    try {
      const res = await fetch('/api/security-scan/diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentScanId: viewingScan.id, previousScanId: samePlatform[0].id }),
      });
      const data = await res.json();
      setDiffResult(data.diff || data.error || 'Unknown error');
    } catch (e: any) {
      setDiffResult(`Error: ${e.message}`);
    } finally {
      setDiffLoading(false);
    }
  }

  async function sendChatMessage() {
    if (!chatInput.trim() || !viewingScan || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    const updatedHistory = [...chatMessages, { role: 'user' as const, content: userMsg }];
    setChatMessages(updatedHistory);
    setChatLoading(true);

    try {
      const res = await fetch('/api/security-scan/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId: viewingScan.id,
          message: userMsg,
          history: chatMessages,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setChatMessages([...updatedHistory, { role: 'assistant', content: data.reply }]);
      } else {
        setChatMessages([...updatedHistory, { role: 'assistant', content: `Error: ${data.error}` }]);
      }
    } catch (e: any) {
      setChatMessages([...updatedHistory, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setChatLoading(false);
    }
  }

  async function loadData() {
    try {
      const [scanRes, repoRes] = await Promise.all([
        fetch('/api/security-scan'),
        fetch('/api/security-scan/repos'),
      ]);
      const scanData = await scanRes.json();
      const repoData = await repoRes.json();
      setScans(scanData.scans || []);
      setModels(scanData.models || []);
      setRepos(repoData.repos || []);
      setPlatforms(repoData.platforms || {});

      // Set default platform if available
      const platformNames = Object.keys(repoData.platforms || {});
      if (platformNames.length > 0 && !platformName) {
        setPlatformName(platformNames[0]);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  useEffect(() => { loadData(); }, []);

  // Live scan progress via WebSocket
  interface ScanProgress {
    scanId: number;
    phase: string;
    agents?: Array<{ id: string; name: string; status: string; chars?: number; cost?: number; attempt?: number }>;
    totalCost?: number;
    duration?: number;
  }
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'scan-progress') {
          const progress = JSON.parse(msg.data);
          setScanProgress(progress);
          // Auto-refresh scan list when done
          if (progress.phase === 'done' || progress.phase === 'failed') {
            setTimeout(() => { loadData(); setScanProgress(null); }, 2000);
          }
        }
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, []);

  // When platform changes, select all repos of that platform
  useEffect(() => {
    if (platformName && platforms[platformName]) {
      setSelectedRepoIds(new Set(platforms[platformName].map(r => r.id)));
    }
  }, [platformName, platforms]);

  function handleGithubUrlChange(url: string) {
    setNewGithubUrl(url);
    // Auto-detect branch from /tree/branch-name in URL
    const branchMatch = url.match(/\/tree\/([^/?#]+)/);
    if (branchMatch) {
      setNewRepoBranch(branchMatch[1]);
    }
  }

  async function addRepo() {
    if (!newRepoPlatform) return;
    if (addMode === 'local' && !newRepoPath) return;
    if (addMode === 'github' && !newGithubUrl) return;

    setAddingRepo(true);
    try {
      const payload: any = { platformName: newRepoPlatform, branch: newRepoBranch };
      if (addMode === 'local') {
        payload.localPath = newRepoPath;
      } else {
        payload.githubUrl = newGithubUrl;
      }

      const res = await fetch('/api/security-scan/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        setNewRepoPath('');
        setNewGithubUrl('');
        setNewRepoBranch('main');
        loadData();
      } else {
        alert(`❌ ${data.error}`);
      }
    } catch (e: any) {
      alert(`❌ ${e.message}`);
    } finally {
      setAddingRepo(false);
    }
  }

  async function removeRepo(id: number) {
    if (!confirm('Repo wirklich entfernen?')) return;
    await fetch('/api/security-scan/repos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    loadData();
  }

  function toggleRepo(id: number) {
    const next = new Set(selectedRepoIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedRepoIds(next);
  }

  function selectAllPlatformRepos() {
    if (platformName && platforms[platformName]) {
      setSelectedRepoIds(new Set(platforms[platformName].map(r => r.id)));
    }
  }

  function deselectAllRepos() {
    setSelectedRepoIds(new Set());
  }

  async function checkFreshnessAndScan() {
    if (!platformName || selectedRepoIds.size === 0) {
      alert('Please select a platform and at least one repo.');
      return;
    }

    const selectedRepos = repos.filter(r => selectedRepoIds.has(r.id));
    const repoPaths = selectedRepos.map(r => r.local_path);

    setCheckingFreshness(true);
    try {
      const res = await fetch('/api/repos/freshness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPaths }),
      });
      if (!res.ok) {
        console.warn('Freshness check failed:', res.status);
        setCheckingFreshness(false);
        executeScan();
        return;
      }
      const data = await res.json();
      const repoResults = data.repos || [];
      const outdated = repoResults.filter((r: any) => !r.upToDate && r.behind > 0);
      const errors = repoResults.filter((r: any) => r.error);
      if (errors.length > 0) {
        console.warn('Freshness check errors:', errors.map((r: any) => `${r.name}: ${r.error}`));
      }
      if (outdated.length > 0) {
        setFreshnessResults(repoResults);
        setCheckingFreshness(false);
        return;
      }
    } catch (e) {
      console.error('Freshness check exception:', e);
    }
    setCheckingFreshness(false);
    executeScan();
  }

  async function executeScan() {
    const selectedRepos = repos.filter(r => selectedRepoIds.has(r.id));
    const repoPaths = selectedRepos.map(r => r.local_path);

    setFreshnessResults(null);
    setStarting(true);
    try {
      const res = await fetch('/api/security-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platformName, repoPaths, model: selectedModel }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(`Security Scan gestartet! ${data.repos.length} Repos, Fortschritt unter Logs.`);
        loadData();
      } else {
        alert(`Fehler: ${data.error}`);
      }
    } catch (e: any) {
      alert(`Fehler: ${e.message}`);
    } finally {
      setStarting(false);
    }
  }

  async function updateOutdatedAndScan() {
    if (!freshnessResults) return;
    const outdated = freshnessResults.filter(r => !r.upToDate && r.behind > 0);
    setUpdatingRepos(true);

    const results = await Promise.all(
      outdated.map(async (repo) => {
        try {
          const res = await fetch('/api/repos/freshness/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoPath: repo.path }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({ error: 'Unknown error' }));
            console.warn(`Failed to update ${repo.name}: ${data.error}`);
            return { name: repo.name, success: false };
          }
          return { name: repo.name, success: true };
        } catch {
          console.warn(`Failed to update ${repo.name}`);
          return { name: repo.name, success: false };
        }
      })
    );

    const failed = results.filter(r => !r.success);
    setUpdatingRepos(false);

    if (failed.length > 0) {
      alert(`❌ Update fehlgeschlagen für:\n${failed.map(r => r.name).join('\n')}\n\nScan wird nicht gestartet.`);
      return;
    }

    executeScan();
  }

  if (loading) return <div className="text-[#666]">Lade Security Scans...</div>;

  // Detail view with chat
  if (viewingScan) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button onClick={() => { setViewingScan(null); setChatMessages([]); setShowChat(false); }} className="btn-secondary text-sm">
              ← Back
            </button>
            <h2 className="text-xl font-bold">🔒 {viewingScan.platform_name} — Security Report</h2>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-3 text-xs text-[#666]">
              <span>{viewingScan.model}</span>
              {viewingScan.duration_seconds && <span>{Math.round(viewingScan.duration_seconds / 60)}min</span>}
              {viewingScan.estimated_cost && <span>${viewingScan.estimated_cost.toFixed(2)}</span>}
            </div>
            <div className="flex items-center gap-1">
              <a
                href={`/api/security-scan/export?scanId=${viewingScan.id}&format=md`}
                download
                className="px-2 py-1.5 rounded-lg text-xs font-medium bg-[#1a1a1a] text-[#888] border border-[#333] hover:border-[#555] transition-colors"
              >
                📄 .md
              </a>
              <a
                href={`/api/security-scan/export?scanId=${viewingScan.id}&format=html`}
                target="_blank"
                className="px-2 py-1.5 rounded-lg text-xs font-medium bg-[#1a1a1a] text-[#888] border border-[#333] hover:border-[#555] transition-colors"
                title="Open as HTML — use Print → Save as PDF"
              >
                🖨️ PDF
              </a>
            </div>
            <button
              onClick={() => setShowChat(!showChat)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                showChat
                  ? 'bg-claude-600/20 text-claude-400 border border-claude-600/40'
                  : 'bg-[#1a1a1a] text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              💬 Ask Agent
            </button>
          </div>
        </div>
        {viewingScan.report_file && (
          <p className="text-xs text-[#555] mb-4">Report: {viewingScan.report_file}</p>
        )}

        <div className={`grid gap-4 ${showChat ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {/* Report Panel */}
          <div className="card overflow-hidden">
            {/* Tabs */}
            <div className="flex gap-1 mb-3 border-b border-[#333] pb-2">
              {([
                { key: 'report', label: '📋 Report' },
                { key: 'architecture', label: '🏗️ Architecture Map' },
                { key: 'agents', label: '🤖 Agent Results' },
                { key: 'coverage', label: '📊 Coverage' },
                { key: 'diff', label: '🔄 Diff' },
              ] as const).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setReportTab(tab.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    reportTab === tab.key
                      ? 'bg-claude-600/20 text-claude-400'
                      : 'text-[#888] hover:text-[#ccc]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
              {/* Summary / Full toggle when on Report tab */}
              {reportTab === 'report' && (
                <div className="flex items-center gap-1 ml-auto">
                  <button
                    onClick={() => setReportMode('summary')}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                      reportMode === 'summary' ? 'bg-claude-600/20 text-claude-400' : 'text-[#666] hover:text-[#aaa]'
                    }`}
                  >
                    Summary
                  </button>
                  <button
                    onClick={() => setReportMode('full')}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                      reportMode === 'full' ? 'bg-claude-600/20 text-claude-400' : 'text-[#666] hover:text-[#aaa]'
                    }`}
                  >
                    Full Report
                  </button>
                </div>
              )}
            </div>
            <div className="max-h-[72vh] overflow-y-auto">
              <pre className="text-sm text-[#ccc] whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto">
                {reportTab === 'report' && (
                  reportMode === 'full'
                    ? (viewingScan.full_report || 'No full report available. Re-run the scan to generate it.')
                    : (viewingScan.report || 'No report available.')
                )}
                {reportTab === 'architecture' && (viewingScan.architecture_map || 'No architecture map available. Run a scan first.')}
                {reportTab === 'agents' && (() => {
                  if (!viewingScan.agent_results) return 'No individual agent results saved. Re-run the scan to capture per-agent outputs.';
                  try {
                    const agents = JSON.parse(viewingScan.agent_results) as Array<{
                      id: string; name: string; success: boolean; chars: number; cost: number; durationMs: number; output: string;
                    }>;
                    return agents.map(a => {
                      const status = !a.success ? '❌ FAILED' : a.chars < 500 ? '⚠️ SUSPICIOUS (short output)' : '✅ OK';
                      const duration = Math.round(a.durationMs / 1000);
                      return `${'═'.repeat(60)}\n${a.name} [${a.id}]\nStatus: ${status} | ${a.chars} chars | ${duration}s | $${a.cost.toFixed(2)}\n${'═'.repeat(60)}\n\n${a.output}\n`;
                    }).join('\n\n');
                  } catch { return 'Failed to parse agent results.'; }
                })()}
                {reportTab === 'coverage' && (() => {
                  const report = viewingScan.report || '';
                  // Try multiple possible section headers
                  const headers = ['## Audit Coverage Summary', '## Coverage Summary', '## Coverage'];
                  let coverageIdx = -1;
                  for (const h of headers) {
                    coverageIdx = report.indexOf(h);
                    if (coverageIdx !== -1) break;
                  }
                  if (coverageIdx !== -1) return report.substring(coverageIdx);

                  // Fallback: check architecture map for file inventory
                  const archMap = viewingScan.architecture_map || '';
                  const invIdx = archMap.indexOf('## Security-Relevant File Inventory');
                  if (invIdx !== -1) return '⚠️ No coverage data in report — showing File Inventory from Architecture Map:\n\n' + archMap.substring(invIdx);

                  return 'No coverage data found. The agents may not have included Coverage Reports.\nRe-run the scan — the prompts have been updated to enforce coverage reporting.';
                })()}
                {reportTab === 'diff' && (() => {
                  if (diffLoading) return '⏳ Generating diff with previous audit...';
                  if (diffResult) return diffResult;
                  return '';
                })()}
              </pre>
              {reportTab === 'diff' && !diffResult && !diffLoading && (
                <div className="text-center py-8">
                  <p className="text-sm text-[#888] mb-3">Compare this audit with the previous one for the same platform.</p>
                  <button onClick={loadDiff} className="btn-primary text-sm">
                    🔄 Generate Diff
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Chat Panel */}
          {showChat && (
            <div className="card flex flex-col" style={{ height: '75vh' }}>
              <div className="border-b border-[#333] pb-2 mb-3">
                <h3 className="text-sm font-semibold">💬 Ask about this audit</h3>
                <p className="text-xs text-[#555]">Ask follow-up questions about findings, request explanations, or discuss fixes.</p>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto space-y-3 mb-3">
                {chatMessages.length === 0 && (
                  <div className="text-center py-8">
                    <p className="text-xs text-[#555] mb-3">Example questions:</p>
                    <div className="space-y-2">
                      {[
                        'Which critical findings should we fix first?',
                        'Explain the IDOR vulnerability in detail',
                        'How do we fix the JWT signing issue?',
                        'Which files were not covered by any agent?',
                        'Are there any false positives in the report?',
                      ].map((q, i) => (
                        <button
                          key={i}
                          onClick={() => { setChatInput(q); }}
                          className="block w-full text-left text-xs text-[#888] bg-[#1a1a1a] rounded-lg px-3 py-2 hover:bg-[#252525] transition-colors"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      msg.role === 'user'
                        ? 'bg-claude-600/20 text-claude-300'
                        : 'bg-[#1a1a1a] text-[#ccc]'
                    }`}>
                      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{msg.content}</pre>
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex justify-start">
                    <div className="bg-[#1a1a1a] rounded-lg px-3 py-2 text-sm text-[#888]">
                      Thinking...
                    </div>
                  </div>
                )}
              </div>

              {/* Input */}
              <div className="flex gap-2 border-t border-[#333] pt-3">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendChatMessage()}
                  placeholder="Ask about the audit..."
                  className="flex-1 bg-[#111] border border-[#444] rounded-lg px-3 py-2 text-sm text-white focus:border-claude-500 focus:outline-none"
                />
                <button
                  onClick={sendChatMessage}
                  disabled={chatLoading || !chatInput.trim()}
                  className="btn-primary text-sm px-4 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const platformNames = Object.keys(platforms);
  const currentPlatformRepos = platformName ? (platforms[platformName] || []) : [];

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">🔒 Security Scan</h2>

      {/* Repo Management */}
      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Repos verwalten</h3>
          <button onClick={() => setShowAddRepo(!showAddRepo)} className="btn-primary text-sm">
            + Repo hinzufügen
          </button>
        </div>

        {/* Add Repo Form */}
        {showAddRepo && (
          <div className="bg-[#1a1a1a] rounded-lg p-4 mb-4 border border-[#333]">
            {/* Source Toggle */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setAddMode('local')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  addMode === 'local'
                    ? 'bg-claude-600/20 text-claude-400 border border-claude-600/40'
                    : 'bg-[#111] text-[#888] border border-[#444] hover:border-[#555]'
                }`}
              >
                Lokaler Pfad
              </button>
              <button
                onClick={() => setAddMode('github')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  addMode === 'github'
                    ? 'bg-claude-600/20 text-claude-400 border border-claude-600/40'
                    : 'bg-[#111] text-[#888] border border-[#444] hover:border-[#555]'
                }`}
              >
                GitHub
              </button>
            </div>

            <div className="grid grid-cols-4 gap-3 mb-3">
              <div>
                <label className="text-xs text-[#888] block mb-1">Platform</label>
                <input
                  type="text"
                  placeholder="z.B. X4T"
                  value={newRepoPlatform}
                  onChange={e => setNewRepoPlatform(e.target.value)}
                  list="platform-suggestions"
                  className="w-full bg-[#111] border border-[#444] rounded-lg px-3 py-2 text-sm text-white focus:border-claude-500 focus:outline-none"
                />
                <datalist id="platform-suggestions">
                  {platformNames.map(p => <option key={p} value={p} />)}
                </datalist>
              </div>
              <div className="col-span-2">
                {addMode === 'local' ? (
                  <>
                    <label className="text-xs text-[#888] block mb-1">Lokaler Pfad</label>
                    <input
                      type="text"
                      placeholder="~/repos/x4tapp/x4t-backend"
                      value={newRepoPath}
                      onChange={e => setNewRepoPath(e.target.value)}
                      className="w-full bg-[#111] border border-[#444] rounded-lg px-3 py-2 text-sm text-white focus:border-claude-500 focus:outline-none"
                    />
                  </>
                ) : (
                  <>
                    <label className="text-xs text-[#888] block mb-1">GitHub URL oder org/repo</label>
                    <input
                      type="text"
                      placeholder="org/repo oder https://github.com/org/repo"
                      value={newGithubUrl}
                      onChange={e => handleGithubUrlChange(e.target.value)}
                      className="w-full bg-[#111] border border-[#444] rounded-lg px-3 py-2 text-sm text-white focus:border-claude-500 focus:outline-none"
                    />
                  </>
                )}
              </div>
              <div>
                <label className="text-xs text-[#888] block mb-1">Branch</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="main"
                    value={newRepoBranch}
                    onChange={e => setNewRepoBranch(e.target.value)}
                    className="flex-1 bg-[#111] border border-[#444] rounded-lg px-3 py-2 text-sm text-white focus:border-claude-500 focus:outline-none"
                  />
                  <button onClick={addRepo} disabled={addingRepo} className="btn-primary text-sm whitespace-nowrap">
                    {addingRepo ? (addMode === 'github' ? 'Cloning...' : '...') : 'Add'}
                  </button>
                </div>
              </div>
            </div>
            <p className="text-xs text-[#555]">
              {addMode === 'local'
                ? 'Verwende einen lokalen Pfad zu einem bereits geklonten Git-Repo.'
                : 'Das Repo wird automatisch nach ~/repos/security-scan/ geklont. GitHub Token muss gesetzt sein.'}
            </p>
          </div>
        )}

        {/* Platform Tabs */}
        {platformNames.length > 0 && (
          <div className="flex gap-2 mb-4 flex-wrap">
            {platformNames.map(p => (
              <button
                key={p}
                onClick={() => setPlatformName(p)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  platformName === p
                    ? 'bg-red-600/20 text-red-400 border border-red-600/40'
                    : 'bg-[#1a1a1a] text-[#888] border border-[#333] hover:border-[#555]'
                }`}
              >
                {p} ({(platforms[p] || []).length})
              </button>
            ))}
          </div>
        )}

        {/* Repo List for selected platform */}
        {currentPlatformRepos.length > 0 ? (
          <div>
            <div className="flex items-center gap-3 mb-2">
              <button onClick={selectAllPlatformRepos} className="text-xs text-claude-400 hover:underline">Select all</button>
              <button onClick={deselectAllRepos} className="text-xs text-[#888] hover:underline">None</button>
              <span className="text-xs text-[#555]">
                {selectedRepoIds.size} von {currentPlatformRepos.length} ausgewählt
              </span>
            </div>
            <div className="grid gap-2">
              {currentPlatformRepos.map(repo => (
                <div
                  key={repo.id}
                  className={`flex items-center justify-between p-3 rounded-lg border transition-colors cursor-pointer ${
                    selectedRepoIds.has(repo.id)
                      ? 'bg-red-900/10 border-red-600/30'
                      : 'bg-[#1a1a1a] border-[#333] hover:border-[#555]'
                  }`}
                  onClick={() => toggleRepo(repo.id)}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selectedRepoIds.has(repo.id)}
                      onChange={() => toggleRepo(repo.id)}
                      className="accent-red-500"
                      onClick={e => e.stopPropagation()}
                    />
                    <div>
                      <span className="text-sm font-medium text-white">{repo.repo_name}</span>
                      <span className="text-xs text-[#555] ml-2">({repo.branch})</span>
                      <span className={`text-xs ml-2 px-1.5 py-0.5 rounded ${
                        repo.source === 'github'
                          ? 'bg-[#1a1a2e] text-blue-400'
                          : 'bg-[#1a2e1a] text-green-400'
                      }`}>
                        {repo.source === 'github' ? 'GitHub' : 'Lokal'}
                      </span>
                      <p className="text-xs text-[#666]">{repo.local_path}</p>
                    </div>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); removeRepo(repo.id); }}
                    className="text-xs text-red-400/50 hover:text-red-400 transition-colors px-2"
                    title="Repo entfernen"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : platformName ? (
          <p className="text-xs text-[#555] text-center py-4">No repos for &quot;{platformName}&quot;. Add repos above.</p>
        ) : (
          <p className="text-xs text-[#555] text-center py-4">Füge zuerst Repos hinzu, um einen Security Scan zu starten.</p>
        )}
      </div>

      {/* Scan Starten */}
      {currentPlatformRepos.length > 0 && (
        <div className="card mb-6">
          <h3 className="text-sm font-semibold mb-4">Start Scan</h3>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="text-xs text-[#888] block mb-1">Modell</label>
              <select
                value={selectedModel}
                onChange={e => setSelectedModel(e.target.value)}
                className="w-full bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-2 text-sm text-white focus:border-claude-500 focus:outline-none"
              >
                {models.map(m => (
                  <option key={m.key} value={m.key}>
                    {m.name} — {m.context} (${m.costPer1MInput}/${m.costPer1MOutput})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col items-end">
              <button
                onClick={checkFreshnessAndScan}
                disabled={starting || checkingFreshness || selectedRepoIds.size === 0}
                className="bg-red-600 hover:bg-red-500 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {checkingFreshness ? '⏳ Checking repos...' : starting ? '⏳ Starting...' : `🔒 Start Scan (${selectedRepoIds.size} Repos)`}
              </button>
              <p className="text-xs text-[#555] mt-1">
                Phase 0: Architecture → Phase 1: 8 Agents → Phase 2: Report
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Previous Scans */}
      {/* Live Scan Progress */}
      {scanProgress && scanProgress.phase !== 'done' && (
        <div className="card mb-4 border border-yellow-600/30">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-yellow-400">
              ⏳ Scan in Progress
              {scanProgress.phase === 'mapping' && ' — Phase 0: Architecture Mapping'}
              {scanProgress.phase === 'agents' && ' — Phase 1: Security Agents'}
              {scanProgress.phase === 'aggregation' && ' — Phase 2: Aggregation'}
            </h3>
            {scanProgress.totalCost != null && (
              <span className="text-xs font-mono text-[#888]">${scanProgress.totalCost.toFixed(2)}</span>
            )}
          </div>
          {scanProgress.agents && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {scanProgress.agents.map(a => (
                <div key={a.id} className={`text-xs rounded-lg px-2 py-1.5 ${
                  a.status === 'done' ? 'bg-green-900/20 text-green-400' :
                  a.status === 'failed' ? 'bg-red-900/20 text-red-400' :
                  a.status === 'running' ? 'bg-yellow-900/20 text-yellow-400' :
                  a.status === 'retrying' ? 'bg-orange-900/20 text-orange-400' :
                  'bg-[#1a1a1a] text-[#555]'
                }`}>
                  <span className="mr-1">
                    {a.status === 'done' ? '✅' : a.status === 'failed' ? '❌' : a.status === 'running' ? '⏳' : a.status === 'retrying' ? '🔄' : '⬜'}
                  </span>
                  {a.name.replace(/ (Flow|Security|& )/g, ' ').trim()}
                  {a.chars ? ` (${a.chars})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <h3 className="text-sm font-semibold mb-3 text-[#888]">Previous Scans</h3>
      {scans.length === 0 ? (
        <div className="card text-center py-8">
          <p className="text-[#666]">No security scans yet</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {scans.map(scan => (
            <div key={scan.id} className="card-hover cursor-pointer" onClick={() => scan.status === 'completed' ? setViewingScan(scan) : null}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <span className="text-base font-semibold">🔒 {scan.platform_name}</span>
                    {scan.status === 'completed' && <span className="badge-success">Completed</span>}
                    {scan.status === 'running' && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-900/30 text-yellow-400">
                        ⏳ Running...
                      </span>
                    )}
                    {scan.status === 'failed' && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-900/30 text-red-400">
                        ❌ Failed
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[#666] mt-1">
                    {scan.repos_dir} · {scan.model} · {scan.total_agents} Agents
                    {scan.duration_seconds ? ` · ${Math.round(scan.duration_seconds / 60)}min` : ''}
                  </p>
                </div>
                <div className="text-right">
                  {scan.estimated_cost && (
                    <span className="text-sm font-mono text-[#888]">${scan.estimated_cost.toFixed(2)}</span>
                  )}
                  <p className="text-xs text-[#555] mt-1">{new Date(scan.created_at + 'Z').toLocaleDateString('de-DE')}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Freshness Check Dialog */}
      {freshnessResults && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl p-6 max-w-lg w-full mx-4">
            <h3 className="text-base font-semibold mb-3 text-yellow-400">Repos nicht aktuell</h3>
            <p className="text-sm text-[#ccc] mb-4">
              Folgende Repos sind nicht auf dem neuesten Stand:
            </p>
            <div className="space-y-2 mb-4 max-h-60 overflow-y-auto">
              {freshnessResults.filter(r => !r.upToDate && r.behind > 0).map((repo, i) => (
                <div key={i} className="bg-[#111] rounded-lg p-3 text-xs font-mono">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-white font-semibold">{repo.name}</span>
                    <span className="text-yellow-400">{repo.behind} Commit{repo.behind !== 1 ? 's' : ''} behind</span>
                  </div>
                  <div className="text-[#888]">
                    <span>Branch: {repo.branch}</span>
                    <span className="mx-2">|</span>
                    <span>Lokal: {repo.localCommit}</span>
                    <span className="mx-2">|</span>
                    <span>Remote: {repo.remoteCommit}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                onClick={updateOutdatedAndScan}
                disabled={updatingRepos}
                className="flex-1 bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {updatingRepos ? '⏳ Updating...' : 'Repos updaten & scannen'}
              </button>
              <button
                onClick={() => executeScan()}
                className="flex-1 bg-[#252525] hover:bg-[#333] text-[#ccc] px-4 py-2 rounded-lg text-sm font-medium transition-colors border border-[#444]"
              >
                Ohne Update scannen
              </button>
            </div>
            <button
              onClick={() => setFreshnessResults(null)}
              className="w-full mt-2 text-xs text-[#666] hover:text-[#999] transition-colors py-1"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
