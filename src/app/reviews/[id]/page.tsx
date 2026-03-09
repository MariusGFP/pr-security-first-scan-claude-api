'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { Review, ReviewAgent } from '@/types';

export default function ReviewDetailPage() {
  const params = useParams();
  const reviewId = params.id as string;
  const [review, setReview] = useState<(Review & { agents: ReviewAgent[] }) | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/reviews?id=${reviewId}`);
      if (res.ok) {
        setReview(await res.json());
      }
      setLoading(false);
    }
    load();
    // Auto-refresh while running
    const interval = setInterval(() => {
      if (review?.status === 'running') load();
    }, 5000);
    return () => clearInterval(interval);
  }, [reviewId]);

  if (loading) return <div className="text-[#666]">Lade Review...</div>;
  if (!review) return <div className="text-red-400">Review nicht gefunden</div>;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <a href="/reviews" className="text-[#666] hover:text-white">&larr;</a>
        <h2 className="text-xl font-bold">
          {review.repo_name}#{review.pr_number}
        </h2>
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
          review.status === 'completed' ? 'bg-green-900/50 text-green-300' :
          review.status === 'running' ? 'bg-yellow-900/50 text-yellow-300' :
          review.status === 'failed' ? 'bg-red-900/50 text-red-300' : 'bg-gray-900/50 text-gray-300'
        }`}>
          {review.status}
        </span>
      </div>

      {/* Info Bar */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <div className="card">
          <p className="text-xs text-[#666]">PR-Titel</p>
          <p className="text-sm mt-1">{review.pr_title}</p>
        </div>
        <div className="card">
          <p className="text-xs text-[#666]">Diff-Größe</p>
          <p className="text-sm mt-1">{review.diff_lines} Zeilen, {review.diff_files} Dateien</p>
        </div>
        <div className="card">
          <p className="text-xs text-[#666]">Agents</p>
          <p className="text-sm mt-1">{review.total_sub_agents} Sub-Agents</p>
        </div>
        <div className="card">
          <p className="text-xs text-[#666]">Dauer</p>
          <p className="text-sm mt-1">{review.duration_seconds ? `${review.duration_seconds}s` : 'Läuft...'}</p>
        </div>
        <div className="card">
          <p className="text-xs text-[#666]">Kosten</p>
          <p className="text-sm mt-1">{review.estimated_cost ? `$${review.estimated_cost.toFixed(2)}` : '—'}</p>
        </div>
      </div>

      {/* Findings Summary */}
      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-[#a0a0a0] mb-3">Findings</h3>
        <div className="flex gap-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🔴</span>
            <div>
              <p className="text-2xl font-bold">{review.findings_critical}</p>
              <p className="text-xs text-[#666]">Kritisch</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xl">🟡</span>
            <div>
              <p className="text-2xl font-bold">{review.findings_warning}</p>
              <p className="text-xs text-[#666]">Warnung</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xl">🔵</span>
            <div>
              <p className="text-2xl font-bold">{review.findings_info}</p>
              <p className="text-xs text-[#666]">Hinweis</p>
            </div>
          </div>
        </div>
      </div>

      {/* Agent Status */}
      {review.agents && review.agents.length > 0 && (
        <div className="card mb-6">
          <h3 className="text-sm font-semibold text-[#a0a0a0] mb-3">Agent-Status</h3>
          <div className="grid grid-cols-3 gap-2">
            {review.agents.map(agent => (
              <div key={agent.id} className="flex items-center gap-2 p-2 rounded bg-[#1a1a1a]">
                <span className={`w-2 h-2 rounded-full ${
                  agent.status === 'completed' ? 'bg-green-500' :
                  agent.status === 'running' ? 'bg-yellow-500 animate-pulse' :
                  agent.status === 'failed' ? 'bg-red-500' : 'bg-gray-500'
                }`} />
                <span className="text-xs font-medium">{agent.agent_name}</span>
                <span className="text-xs text-[#555] ml-auto">
                  {agent.sub_agent_count > 0 && `${agent.sub_agent_count} subs`}
                  {agent.duration_seconds && ` · ${agent.duration_seconds}s`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full Report */}
      {review.aggregated_result && (
        <div className="card">
          <h3 className="text-sm font-semibold text-[#a0a0a0] mb-3">Vollständiger Report</h3>
          <div className="prose prose-invert prose-sm max-w-none">
            <pre className="whitespace-pre-wrap text-sm text-[#ccc] font-sans leading-relaxed">
              {review.aggregated_result}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
