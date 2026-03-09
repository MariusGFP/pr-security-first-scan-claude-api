'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { Repo, Review } from '@/types';

export default function RepoDetailPage() {
  const params = useParams();
  const repoId = params.id as string;
  const [repo, setRepo] = useState<Repo | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [reposRes, reviewsRes] = await Promise.all([
        fetch('/api/repos'),
        fetch(`/api/reviews?repoId=${repoId}&limit=20`),
      ]);
      const repos = await reposRes.json();
      const found = repos.find((r: Repo) => r.id === parseInt(repoId));
      setRepo(found || null);

      const reviewData = await reviewsRes.json();
      setReviews(reviewData.reviews || []);
      setLoading(false);
    }
    load();
  }, [repoId]);

  if (loading) return <div className="text-[#666]">Lade...</div>;
  if (!repo) return <div className="text-red-400">Repo nicht gefunden</div>;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <a href="/repos" className="text-[#666] hover:text-white">&larr;</a>
        <h2 className="text-xl font-bold">{repo.full_name}</h2>
        {repo.monitoring_active ? (
          <span className="badge-success">Aktiv</span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#333] text-[#888]">Inaktiv</span>
        )}
      </div>

      {/* Info */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card">
          <p className="text-xs text-[#666]">Pfad</p>
          <p className="text-sm font-mono mt-1">{repo.local_path}</p>
        </div>
        <div className="card">
          <p className="text-xs text-[#666]">Base Branch</p>
          <p className="text-sm mt-1">{repo.base_branch}</p>
        </div>
        <div className="card">
          <p className="text-xs text-[#666]">Webhook</p>
          <p className="text-sm mt-1">{repo.webhook_id ? `#${repo.webhook_id}` : 'Nicht eingerichtet'}</p>
        </div>
      </div>

      {/* Reviews */}
      <div className="card">
        <h3 className="text-sm font-semibold text-[#a0a0a0] mb-4">Reviews ({reviews.length})</h3>
        {reviews.length === 0 ? (
          <p className="text-sm text-[#666]">Noch keine Reviews</p>
        ) : (
          <div className="space-y-2">
            {reviews.map(review => (
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
                  <span className="text-sm">PR #{review.pr_number}: {review.pr_title}</span>
                </div>
                <div className="flex items-center gap-4 text-xs text-[#666]">
                  <span>{review.diff_lines} Zeilen</span>
                  <span>{review.total_sub_agents} Agents</span>
                  <span>{review.duration_seconds}s</span>
                  <span>{review.estimated_cost ? `$${review.estimated_cost.toFixed(2)}` : '—'}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
