'use client';

import { useEffect, useState } from 'react';
import type { DashboardStats, Review } from '@/types';

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card">
      <p className="text-sm text-[#a0a0a0]">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {sub && <p className="text-xs text-[#666] mt-1">{sub}</p>}
    </div>
  );
}

function FindingsBadge({ critical, warning, info }: { critical: number; warning: number; info: number }) {
  return (
    <div className="flex gap-2">
      {critical > 0 && <span className="badge-critical">{critical} 🔴</span>}
      {warning > 0 && <span className="badge-warning">{warning} 🟡</span>}
      {info > 0 && <span className="badge-info">{info} 🔵</span>}
      {critical === 0 && warning === 0 && info === 0 && <span className="badge-success">Clean</span>}
    </div>
  );
}

function timeAgo(dateStr: string): string {
  // SQLite stores UTC timestamps — ensure they're parsed as UTC
  const utcStr = dateStr.endsWith('Z') ? dateStr : dateStr + 'Z';
  const diff = Date.now() - new Date(utcStr).getTime();
  if (diff < 0) return 'gerade eben';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours}h`;
  const days = Math.floor(hours / 24);
  return `vor ${days}d`;
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [healthRes, reviewsRes] = await Promise.all([
          fetch('/api/health'),
          fetch('/api/reviews?limit=10'),
        ]);
        const health = await healthRes.json();
        const reviewData = await reviewsRes.json();

        setStats({
          totalReviews: health.stats.totalReviews,
          totalRepos: health.stats.totalRepos,
          activeReviews: health.activeReviews.length,
          totalCostThisMonth: health.stats.costThisMonth,
          totalCostAllTime: 0,
          recentReviews: reviewData.reviews || [],
          costByDay: [],
          findingsByCategory: [],
        });
      } catch (e) {
        console.error('Dashboard load error:', e);
      }
      setLoading(false);
    }
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-[#666]">Lade Dashboard...</div>
      </div>
    );
  }

  if (!stats) {
    return <div className="text-red-400">Fehler beim Laden</div>;
  }

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">Dashboard</h2>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard label="Repositories" value={stats.totalRepos} />
        <StatCard label="Total Reviews" value={stats.totalReviews} />
        <StatCard
          label="Aktive Reviews"
          value={stats.activeReviews}
          sub={stats.activeReviews > 0 ? 'Laufen gerade...' : 'Keine aktiven'}
        />
        <StatCard
          label="Kosten (Monat)"
          value={`$${stats.totalCostThisMonth.toFixed(2)}`}
        />
      </div>

      {/* Active Reviews */}
      {stats.activeReviews > 0 && (
        <div className="card mb-6 border-claude-500/30">
          <h3 className="text-sm font-semibold text-claude-400 mb-2">Aktive Reviews</h3>
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-claude-500 animate-pulse" />
            <span className="text-sm">{stats.activeReviews} Review(s) laufen gerade</span>
          </div>
        </div>
      )}

      {/* Recent Reviews */}
      <div className="card">
        <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">Letzte Reviews</h3>

        {stats.recentReviews.length === 0 ? (
          <p className="text-sm text-[#666]">Noch keine Reviews vorhanden</p>
        ) : (
          <div className="space-y-2">
            {stats.recentReviews.map((review: Review) => (
              <a
                key={review.id}
                href={`/reviews/${review.id}`}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-[#1a1a1a] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${
                    review.status === 'completed' ? 'bg-green-500' :
                    review.status === 'running' ? 'bg-yellow-500 animate-pulse' :
                    review.status === 'failed' ? 'bg-red-500' : 'bg-gray-500'
                  }`} />
                  <div>
                    <span className="text-sm font-medium">{review.repo_name}#{review.pr_number}</span>
                    <span className="text-xs text-[#666] ml-2">{review.pr_title}</span>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <FindingsBadge
                    critical={review.findings_critical}
                    warning={review.findings_warning}
                    info={review.findings_info}
                  />
                  <span className="text-xs text-[#666]">
                    {review.duration_seconds ? `${review.duration_seconds}s` : '—'}
                  </span>
                  <span className="text-xs text-[#666]">
                    {review.estimated_cost ? `$${review.estimated_cost.toFixed(2)}` : '—'}
                  </span>
                  <span className="text-xs text-[#555]">
                    {timeAgo(review.created_at)}
                  </span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
