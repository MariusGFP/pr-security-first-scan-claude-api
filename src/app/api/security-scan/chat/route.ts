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
        timeout: 120000, // 2 min
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
  const { scanId, message, history } = await req.json();

  if (!scanId || !message) {
    return NextResponse.json({ error: 'scanId and message required' }, { status: 400 });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: 'Anthropic API key not configured. Set it in Settings.' }, { status: 500 });
  }

  // Load scan data
  const scan = getDb().prepare('SELECT * FROM security_scans WHERE id = ?').get(scanId) as any;
  if (!scan) {
    return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  }

  const systemPrompt = `You are a Security Audit Assistant for the "${scan.platform_name}" platform.

You have access to the full security audit report and architecture map from a recent scan.
Answer questions about the findings, explain vulnerabilities, suggest fixes, and help prioritize remediation.

Be concise and technical. Reference specific files and line numbers when relevant.
All responses in English.

## Architecture Map
${(scan.architecture_map || '').substring(0, 10000)}

## Security Audit Report
${(scan.report || '').substring(0, 30000)}`;

  // Build message history (limit to last 10 messages to avoid context overflow)
  const messages: Array<{ role: string; content: string }> = [];
  if (history && Array.isArray(history)) {
    const recent = history.slice(-10);
    for (const msg of recent) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: 'user', content: message });

  try {
    const data = await callAnthropic(apiKey, {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });

    const reply = (data.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    return NextResponse.json({
      reply,
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
    });
  } catch (e: any) {
    console.error('Chat API error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
