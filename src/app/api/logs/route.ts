export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.env.HOME || '~', 'automation', 'logs', 'webhook.log');

export async function GET() {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return NextResponse.json({ logs: [] });
    }

    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean).slice(-200); // Last 200 lines

    return NextResponse.json({ logs: lines });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
