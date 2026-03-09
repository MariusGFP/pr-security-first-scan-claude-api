import Database from 'better-sqlite3';
import path from 'path';
import type { Repo, Review, ReviewAgent, Scan, CostEntry, DashboardStats } from '@/types';

const DB_PATH = path.join(process.env.HOME || '~', 'automation', 'data', 'dashboard.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      org TEXT NOT NULL,
      full_name TEXT NOT NULL UNIQUE,
      local_path TEXT NOT NULL,
      base_branch TEXT DEFAULT 'main',
      webhook_id INTEGER,
      monitoring_active INTEGER DEFAULT 1,
      thresholds_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER REFERENCES repos(id),
      pr_number INTEGER NOT NULL,
      pr_title TEXT,
      pr_branch TEXT,
      pr_body TEXT,
      status TEXT DEFAULT 'pending',
      diff_lines INTEGER DEFAULT 0,
      diff_files INTEGER DEFAULT 0,
      total_sub_agents INTEGER DEFAULT 0,
      duration_seconds INTEGER,
      findings_critical INTEGER DEFAULT 0,
      findings_warning INTEGER DEFAULT 0,
      findings_info INTEGER DEFAULT 0,
      aggregated_result TEXT,
      estimated_cost REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS review_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER REFERENCES reviews(id),
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      sub_agent_count INTEGER DEFAULT 0,
      duration_seconds INTEGER,
      result TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER REFERENCES repos(id),
      status TEXT DEFAULT 'pending',
      total_agents INTEGER DEFAULT 0,
      duration_seconds INTEGER,
      report TEXT,
      estimated_cost REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      reference_id INTEGER,
      repo_id INTEGER REFERENCES repos(id),
      estimated_tokens INTEGER DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_reviews_repo ON reviews(repo_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
    CREATE INDEX IF NOT EXISTS idx_review_agents_review ON review_agents(review_id);
    CREATE INDEX IF NOT EXISTS idx_costs_repo ON costs(repo_id);
    CREATE INDEX IF NOT EXISTS idx_costs_created ON costs(created_at);
  `);
}

// ──────────────────────────────────────────────
// Repos
// ──────────────────────────────────────────────

export function getAllRepos(): Repo[] {
  return getDb().prepare('SELECT * FROM repos ORDER BY name').all() as Repo[];
}

export function getRepoById(id: number): Repo | undefined {
  return getDb().prepare('SELECT * FROM repos WHERE id = ?').get(id) as Repo | undefined;
}

export function getRepoByName(name: string): Repo | undefined {
  return getDb().prepare('SELECT * FROM repos WHERE name = ?').get(name) as Repo | undefined;
}

export function createRepo(repo: Omit<Repo, 'id' | 'created_at'>): number {
  const result = getDb().prepare(
    `INSERT INTO repos (name, org, full_name, local_path, base_branch, webhook_id, monitoring_active, thresholds_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(repo.name, repo.org, repo.full_name, repo.local_path, repo.base_branch, repo.webhook_id, repo.monitoring_active ? 1 : 0, repo.thresholds_json);
  return result.lastInsertRowid as number;
}

export function updateRepo(id: number, updates: Partial<Repo>) {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id' || key === 'created_at') continue;
    fields.push(`${key} = ?`);
    values.push(key === 'monitoring_active' ? (value ? 1 : 0) : value);
  }
  values.push(id);
  getDb().prepare(`UPDATE repos SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteRepo(id: number) {
  getDb().prepare('DELETE FROM repos WHERE id = ?').run(id);
}

// ──────────────────────────────────────────────
// Reviews
// ──────────────────────────────────────────────

export function getReviews(limit = 50, repoId?: number): Review[] {
  if (repoId) {
    return getDb().prepare(
      `SELECT r.*, repos.name as repo_name, repos.full_name as repo_full_name
       FROM reviews r JOIN repos ON r.repo_id = repos.id
       WHERE r.repo_id = ? ORDER BY r.created_at DESC LIMIT ?`
    ).all(repoId, limit) as Review[];
  }
  return getDb().prepare(
    `SELECT r.*, repos.name as repo_name, repos.full_name as repo_full_name
     FROM reviews r JOIN repos ON r.repo_id = repos.id
     ORDER BY r.created_at DESC LIMIT ?`
  ).all(limit) as Review[];
}

export function getReviewById(id: number): Review | undefined {
  return getDb().prepare(
    `SELECT r.*, repos.name as repo_name, repos.full_name as repo_full_name
     FROM reviews r JOIN repos ON r.repo_id = repos.id WHERE r.id = ?`
  ).get(id) as Review | undefined;
}

export function createReview(review: Partial<Review>): number {
  const result = getDb().prepare(
    `INSERT INTO reviews (repo_id, pr_number, pr_title, pr_branch, pr_body, status, diff_lines, diff_files)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`
  ).run(review.repo_id, review.pr_number, review.pr_title, review.pr_branch, review.pr_body, review.diff_lines || 0, review.diff_files || 0);
  return result.lastInsertRowid as number;
}

export function updateReview(id: number, updates: Partial<Review>) {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id' || key === 'created_at') continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  values.push(id);
  getDb().prepare(`UPDATE reviews SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function hasBeenReviewed(repoName: string, prNumber: number): boolean {
  const review = getDb().prepare(
    `SELECT r.id FROM reviews r JOIN repos ON r.repo_id = repos.id
     WHERE repos.name = ? AND r.pr_number = ? AND r.status = 'completed'`
  ).get(repoName, prNumber);
  return !!review;
}

// ──────────────────────────────────────────────
// Review Agents
// ──────────────────────────────────────────────

export function getReviewAgents(reviewId: number): ReviewAgent[] {
  return getDb().prepare('SELECT * FROM review_agents WHERE review_id = ? ORDER BY agent_id').all(reviewId) as ReviewAgent[];
}

export function createReviewAgent(agent: Partial<ReviewAgent>): number {
  const result = getDb().prepare(
    `INSERT INTO review_agents (review_id, agent_id, agent_name, status) VALUES (?, ?, ?, 'pending')`
  ).run(agent.review_id, agent.agent_id, agent.agent_name);
  return result.lastInsertRowid as number;
}

export function updateReviewAgent(id: number, updates: Partial<ReviewAgent>) {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id' || key === 'created_at') continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  values.push(id);
  getDb().prepare(`UPDATE review_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

// ──────────────────────────────────────────────
// Costs
// ──────────────────────────────────────────────

export function addCost(entry: Omit<CostEntry, 'id' | 'created_at'>) {
  getDb().prepare(
    `INSERT INTO costs (type, reference_id, repo_id, estimated_tokens, estimated_cost) VALUES (?, ?, ?, ?, ?)`
  ).run(entry.type, entry.reference_id, entry.repo_id, entry.estimated_tokens, entry.estimated_cost);
}

export function getCostThisMonth(): number {
  const result = getDb().prepare(
    `SELECT COALESCE(SUM(estimated_cost), 0) as total FROM costs
     WHERE created_at >= date('now', 'start of month')`
  ).get() as { total: number };
  return result.total;
}

export function getCostAllTime(): number {
  const result = getDb().prepare(
    `SELECT COALESCE(SUM(estimated_cost), 0) as total FROM costs`
  ).get() as { total: number };
  return result.total;
}

export function getCostByDay(days = 30): { date: string; cost: number }[] {
  return getDb().prepare(
    `SELECT date(created_at) as date, SUM(estimated_cost) as cost
     FROM costs WHERE created_at >= date('now', '-' || ? || ' days')
     GROUP BY date(created_at) ORDER BY date`
  ).all(days) as { date: string; cost: number }[];
}

// ──────────────────────────────────────────────
// Scans
// ──────────────────────────────────────────────

export function getScans(repoId?: number): Scan[] {
  if (repoId) {
    return getDb().prepare('SELECT * FROM scans WHERE repo_id = ? ORDER BY created_at DESC').all(repoId) as Scan[];
  }
  return getDb().prepare('SELECT * FROM scans ORDER BY created_at DESC').all() as Scan[];
}

export function createScan(scan: Partial<Scan>): number {
  const result = getDb().prepare(
    `INSERT INTO scans (repo_id, status) VALUES (?, 'running')`
  ).run(scan.repo_id);
  return result.lastInsertRowid as number;
}

export function updateScan(id: number, updates: Partial<Scan>) {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id' || key === 'created_at') continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  values.push(id);
  getDb().prepare(`UPDATE scans SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

// ──────────────────────────────────────────────
// Dashboard Stats
// ──────────────────────────────────────────────

export function getDashboardStats(): DashboardStats {
  const db = getDb();

  const totalReviews = (db.prepare('SELECT COUNT(*) as c FROM reviews').get() as { c: number }).c;
  const totalRepos = (db.prepare('SELECT COUNT(*) as c FROM repos').get() as { c: number }).c;
  const activeReviews = (db.prepare("SELECT COUNT(*) as c FROM reviews WHERE status = 'running'").get() as { c: number }).c;
  const totalCostThisMonth = getCostThisMonth();
  const totalCostAllTime = getCostAllTime();
  const recentReviews = getReviews(10);
  const costByDay = getCostByDay(30);

  return {
    totalReviews,
    totalRepos,
    activeReviews,
    totalCostThisMonth,
    totalCostAllTime,
    recentReviews,
    costByDay,
    findingsByCategory: [],
  };
}
