export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getReviews, getReviewById, getReviewAgents } from '@/lib/db';
import { getActiveReviews } from '@/lib/review-engine';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const repoId = searchParams.get('repoId');
  const limit = parseInt(searchParams.get('limit') || '50');

  if (id) {
    const review = getReviewById(parseInt(id));
    if (!review) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const agents = getReviewAgents(review.id);
    return NextResponse.json({ ...review, agents });
  }

  const reviews = getReviews(limit, repoId ? parseInt(repoId) : undefined);
  const active = getActiveReviews();

  return NextResponse.json({ reviews, active });
}
