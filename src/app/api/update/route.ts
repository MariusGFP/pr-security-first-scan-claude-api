import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { resolve } from 'path';

const PROJECT_DIR = resolve(process.cwd());

function run(cmd: string): string {
  return execSync(cmd, { cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 120_000 }).trim();
}

// GET: Check for available updates
export async function GET() {
  try {
    const currentCommit = run('git rev-parse --short HEAD');
    const currentMessage = run('git log -1 --format=%s');
    const currentDate = run('git log -1 --format=%ci');
    const branch = run('git rev-parse --abbrev-ref HEAD');

    // Fetch latest from remote
    try {
      run('git fetch origin');
    } catch {
      return NextResponse.json({
        current: { commit: currentCommit, message: currentMessage, date: currentDate, branch },
        updateAvailable: false,
        error: 'Could not reach remote repository',
      });
    }

    // Compare local vs remote
    let behind = 0;
    let remoteCommit = currentCommit;
    let remoteMessage = currentMessage;
    try {
      behind = parseInt(run(`git rev-list --count HEAD..origin/${branch}`), 10);
      if (behind > 0) {
        remoteCommit = run(`git rev-parse --short origin/${branch}`);
        remoteMessage = run(`git log -1 --format=%s origin/${branch}`);
      }
    } catch {
      // No upstream tracking
    }

    return NextResponse.json({
      current: { commit: currentCommit, message: currentMessage, date: currentDate, branch },
      remote: { commit: remoteCommit, message: remoteMessage },
      updateAvailable: behind > 0,
      commitsAhead: (() => { try { return parseInt(run(`git rev-list --count origin/${branch}..HEAD`), 10); } catch { return 0; } })(),
      commitsBehind: behind,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST: Execute update
let updateInProgress = false;

export async function POST() {
  if (updateInProgress) {
    return new Response(
      JSON.stringify({ error: 'Update already in progress' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }
  updateInProgress = true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(step: string, status: 'running' | 'done' | 'error', message: string) {
        controller.enqueue(encoder.encode(JSON.stringify({ step, status, message }) + '\n'));
      }

      try {
        // Step 1: Git Pull
        const branch = run('git rev-parse --abbrev-ref HEAD');
        if (!/^[\w.\-/]+$/.test(branch)) {
          send('pull', 'error', `Invalid branch name: ${branch}`);
          updateInProgress = false;
          controller.close();
          return;
        }
        send('pull', 'running', `Pulling latest changes from ${branch}...`);
        try {
          const pullResult = run(`git pull origin ${branch}`);
          send('pull', 'done', pullResult);
        } catch (e: any) {
          send('pull', 'error', e.message);
          controller.close();
          return;
        }

        // Step 2: npm install
        send('install', 'running', 'Installing dependencies...');
        try {
          run('npm install --production=false');
          send('install', 'done', 'Dependencies installed');
        } catch (e: any) {
          send('install', 'error', e.message);
          controller.close();
          return;
        }

        // Step 3: Build
        send('build', 'running', 'Building application...');
        try {
          run('npm run build');
          send('build', 'done', 'Build successful');
        } catch (e: any) {
          send('build', 'error', e.message);
          controller.close();
          return;
        }

        // Step 4: Restart
        send('restart', 'running', 'Restarting server...');
        send('restart', 'done', 'Server will restart now');
        controller.close();

        // Give the response time to flush, then exit with code 42
        setTimeout(() => {
          process.exit(42);
        }, 1000);

      } catch (error: any) {
        updateInProgress = false;
        send('error', 'error', error.message);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
