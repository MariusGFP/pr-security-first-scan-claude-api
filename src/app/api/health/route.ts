export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getDashboardStats } from '@/lib/db';
import { getActiveReviews } from '@/lib/review-engine';

export async function GET() {
  const stats = getDashboardStats();
  const active = getActiveReviews();

  return NextResponse.json({
    status: 'ok',
    uptime: process.uptime(),
    activeReviews: active,
    stats: {
      totalReviews: stats.totalReviews,
      totalRepos: stats.totalRepos,
      costThisMonth: stats.totalCostThisMonth,
    },
    timestamp: new Date().toISOString(),
  });
}
