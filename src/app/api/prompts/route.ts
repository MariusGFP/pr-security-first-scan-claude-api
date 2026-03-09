export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const PROMPTS_DIR = path.join(process.cwd(), 'prompts');

// GET: List all prompts with contents
export async function GET() {
  const prompts: { id: string; name: string; content: string; path: string }[] = [];

  // PR-Review prompts
  const prReviewDir = path.join(PROMPTS_DIR, 'pr-review');
  if (fs.existsSync(prReviewDir)) {
    const files = fs.readdirSync(prReviewDir).filter(f => f.endsWith('.md')).sort();
    for (const file of files) {
      const filePath = path.join(prReviewDir, file);
      prompts.push({
        id: file.replace('.md', ''),
        name: file.replace('.md', '').replace(/^\d+-/, '').replace(/-/g, ' '),
        content: fs.readFileSync(filePath, 'utf8'),
        path: `pr-review/${file}`,
      });
    }
  }

  // Aggregation prompt
  const aggPath = path.join(PROMPTS_DIR, 'aggregation.md');
  if (fs.existsSync(aggPath)) {
    prompts.push({
      id: 'aggregation',
      name: 'Aggregation',
      content: fs.readFileSync(aggPath, 'utf8'),
      path: 'aggregation.md',
    });
  }

  // CLAUDE.md generator prompt
  const genPath = path.join(PROMPTS_DIR, 'claude-md-generator.md');
  if (fs.existsSync(genPath)) {
    prompts.push({
      id: 'claude-md-generator',
      name: 'CLAUDE.md Generator',
      content: fs.readFileSync(genPath, 'utf8'),
      path: 'claude-md-generator.md',
    });
  }

  return NextResponse.json(prompts);
}

// POST: Update a prompt
export async function POST(req: NextRequest) {
  const { promptPath, content } = await req.json();

  if (!promptPath || !content) {
    return NextResponse.json({ error: 'promptPath and content required' }, { status: 400 });
  }

  // Security: only allow writing to prompts dir
  const fullPath = path.join(PROMPTS_DIR, promptPath);
  if (!fullPath.startsWith(PROMPTS_DIR)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
  }

  fs.writeFileSync(fullPath, content);
  return NextResponse.json({ status: 'updated', path: promptPath });
}
