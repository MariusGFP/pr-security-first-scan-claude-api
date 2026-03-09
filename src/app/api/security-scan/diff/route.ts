export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import https from 'https';

function getApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const keysFile = path.join(process.env.HOME || '~', '.keys');
    const content = fs.readFileSync(keysFile, 'utf8');
    const match = content.match(/^export\s+ANTHROPIC_API_KEY=["']?(.+?)["']?\s*$/m);
    if (match) return match[1];
  } catch { /* ignore */ }
  return '';
}

function callAnthropic(apiKey: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: 120000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`API error ${res.statusCode}: ${json.error?.message || data.substring(0, 200)}`));
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(`Failed to parse response: ${data.substring(0, 200)}`));
          }
        });
      }
    );
    req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (120s)')); });
    req.write(payload);
    req.end();
  });
}

export async function POST(req: NextRequest) {
  const { currentScanId, previousScanId } = await req.json();

  if (!currentScanId || !previousScanId) {
    return NextResponse.json({ error: 'currentScanId and previousScanId required' }, { status: 400 });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: 'Anthropic API key not configured.' }, { status: 500 });
  }

  const current = getDb().prepare('SELECT * FROM security_scans WHERE id = ?').get(currentScanId) as any;
  const previous = getDb().prepare('SELECT * FROM security_scans WHERE id = ?').get(previousScanId) as any;

  if (!current || !previous) {
    return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  }

  const prompt = `Compare these two security audit reports for the "${current.platform_name}" platform and produce a diff summary.

## PREVIOUS AUDIT (${previous.created_at})
${(previous.report || '').substring(0, 20000)}

## CURRENT AUDIT (${current.created_at})
${(current.report || '').substring(0, 20000)}

## Instructions
Create a structured diff report with these sections:

### Summary
- Total findings previous: X → current: Y (delta: +/-Z)
- Critical previous: X → current: Y
- High previous: X → current: Y

### ✅ Fixed (findings in previous but NOT in current)
For each: severity, category, file, one-line description

### 🆕 New (findings in current but NOT in previous)
For each: severity, category, file, one-line description

### ⏳ Still Open (findings in BOTH audits)
For each: severity, category, file, any change in severity/confidence

### 📊 Trend
- Overall security posture: Improved / Degraded / Unchanged
- Key improvements
- Key regressions
- Recommended next actions

Be concise. Match findings by file path + category, not by exact wording.
All text in English.`;

  try {
    const data = await callAnthropic(apiKey, {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const reply = (data.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    return NextResponse.json({ diff: reply });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
