'use client';

import { useEffect, useState } from 'react';
import type { Review } from '@/types';

export default function ReviewsPage() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const res = await fetch('/api/reviews?limit=50');
      const data = await res.json();
      setReviews(data.reviews || []);
      setLoading(false);
    }
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div className="text-[#666]">Lade Reviews...</div>;

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">Reviews</h2>

      {reviews.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-[#666]">Noch keine Reviews vorhanden</p>
          <p className="text-xs text-[#555] mt-1">Reviews werden automatisch bei neuen PRs erstellt</p>
        </div>
      ) : (
        <div className="card">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-[#666] border-b border-[#262626]">
                <th className="pb-2 text-left">Status</th>
                <th className="pb-2 text-left">Repo</th>
                <th className="pb-2 text-left">PR</th>
                <th className="pb-2 text-left">Titel</th>
                <th className="pb-2 text-right">Findings</th>
                <th className="pb-2 text-right">Zeilen</th>
                <th className="pb-2 text-right">Agents</th>
                <th className="pb-2 text-right">Dauer</th>
                <th className="pb-2 text-right">Kosten</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map(review => (
                <tr key={review.id} className="border-b border-[#1a1a1a] hover:bg-[#1a1a1a] transition-colors">
                  <td className="py-3">
                    <span className={`w-2 h-2 rounded-full inline-block ${
                      review.status === 'completed' ? 'bg-green-500' :
                      review.status === 'running' ? 'bg-yellow-500 animate-pulse' :
                      review.status === 'failed' ? 'bg-red-500' : 'bg-gray-500'
                    }`} />
                  </td>
                  <td className="py-3 text-sm">{review.repo_name}</td>
                  <td className="py-3">
                    <a href={`/reviews/${review.id}`} className="text-sm text-claude-400 hover:underline">
                      #{review.pr_number}
                    </a>
                  </td>
                  <td className="py-3 text-sm text-[#a0a0a0] max-w-xs truncate">{review.pr_title}</td>
                  <td className="py-3 text-right">
                    <div className="flex gap-1 justify-end">
                      {review.findings_critical > 0 && <span className="badge-critical">{review.findings_critical}</span>}
                      {review.findings_warning > 0 && <span className="badge-warning">{review.findings_warning}</span>}
                      {review.findings_info > 0 && <span className="badge-info">{review.findings_info}</span>}
                    </div>
                  </td>
                  <td className="py-3 text-right text-xs text-[#666]">{review.diff_lines}</td>
                  <td className="py-3 text-right text-xs text-[#666]">{review.total_sub_agents}</td>
                  <td className="py-3 text-right text-xs text-[#666]">{review.duration_seconds ? `${review.duration_seconds}s` : '—'}</td>
                  <td className="py-3 text-right text-xs text-[#666]">{review.estimated_cost ? `$${review.estimated_cost.toFixed(2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
