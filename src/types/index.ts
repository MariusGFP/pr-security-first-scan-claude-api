// ──────────────────────────────────────────────
// Database Models
// ──────────────────────────────────────────────

export interface Repo {
  id: number;
  name: string;
  org: string;
  full_name: string;
  local_path: string;
  base_branch: string;
  webhook_id: number | null;
  monitoring_active: boolean;
  thresholds_json: string | null;
  created_at: string;
}

export interface Review {
  id: number;
  repo_id: number;
  pr_number: number;
  pr_title: string;
  pr_branch: string;
  pr_body: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  diff_lines: number;
  diff_files: number;
  total_sub_agents: number;
  duration_seconds: number | null;
  findings_critical: number;
  findings_warning: number;
  findings_info: number;
  aggregated_result: string | null;
  estimated_cost: number | null;
  created_at: string;
  completed_at: string | null;
  // Joined fields
  repo_name?: string;
  repo_full_name?: string;
}

export interface ReviewAgent {
  id: number;
  review_id: number;
  agent_id: string;
  agent_name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  sub_agent_count: number;
  duration_seconds: number | null;
  result: string | null;
  created_at: string;
}

export interface Scan {
  id: number;
  repo_id: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  total_agents: number;
  duration_seconds: number | null;
  report: string | null;
  estimated_cost: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface CostEntry {
  id: number;
  type: 'review' | 'scan' | 'security-scan';
  reference_id: number;
  repo_id: number;
  estimated_tokens: number;
  estimated_cost: number;
  created_at: string;
}

// ──────────────────────────────────────────────
// Agent Configuration
// ──────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  focus: string;
}

export const AGENTS: AgentConfig[] = [
  { id: '01-code-quality',      name: 'Code Quality',      focus: 'Code smells, duplication, complexity, style inconsistencies' },
  { id: '02-bug-analysis',      name: 'Bug Analysis',      focus: 'Logic errors, edge cases, race conditions, runtime errors' },
  { id: '03-security',          name: 'Security',          focus: 'XSS, injection, insecure API calls, missing input validation, auth issues' },
  { id: '04-best-practices',    name: 'Best Practices',    focus: 'Framework patterns, conventions, anti-patterns' },
  { id: '05-dead-code',         name: 'Dead Code',         focus: 'Unused imports, variables, functions, unreachable code' },
  { id: '06-behavioral-impact', name: 'Behavioral Impact', focus: 'UI bugs, state issues, rendering problems, UX inconsistencies' },
  { id: '07-performance',       name: 'Performance',       focus: 'Bundle size, re-renders, memoization, lazy loading, caching' },
  { id: '08-test-coverage',     name: 'Test Coverage',     focus: 'Missing tests, untested paths, test suggestions' },
  { id: '09-dependency-check',  name: 'Dependencies',      focus: 'Outdated packages, CVEs, unnecessary dependencies' },
  { id: '10-ai-code-safety',   name: 'AI Code Safety',    focus: 'Hallucinated APIs, fake implementations, copy-paste errors, missing business validation, inconsistent auth' },
];

// ──────────────────────────────────────────────
// Thresholds
// ──────────────────────────────────────────────

export interface Thresholds {
  small: number;   // < this = 1 agent per category
  medium: number;  // < this = 2 sub-agents
  large: number;   // < this = 3 sub-agents, > this = dynamic (max 5)
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  small: 500,
  medium: 2000,
  large: 5000,
};

// ──────────────────────────────────────────────
// GitHub Webhook Types
// ──────────────────────────────────────────────

export interface GitHubWebhookPayload {
  action: string;
  repository: {
    name: string;
    full_name: string;
  };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    head: { ref: string };
  };
  issue?: {
    number: number;
    pull_request?: unknown;
  };
  comment?: {
    body: string;
  };
  zen?: string;
}

// ──────────────────────────────────────────────
// WebSocket Messages
// ──────────────────────────────────────────────

export type WSMessage =
  | { type: 'log'; data: string; timestamp: string }
  | { type: 'review_started'; data: { reviewId: number; repo: string; pr: number } }
  | { type: 'agent_update'; data: { reviewId: number; agentId: string; status: string; subAgents?: number } }
  | { type: 'review_completed'; data: { reviewId: number; duration: number; findings: { critical: number; warning: number; info: number } } }
  | { type: 'review_failed'; data: { reviewId: number; error: string } }
  | { type: 'scan-progress'; data: string; timestamp: string };

// ──────────────────────────────────────────────
// API Responses
// ──────────────────────────────────────────────

export interface DashboardStats {
  totalReviews: number;
  totalRepos: number;
  activeReviews: number;
  totalCostThisMonth: number;
  totalCostAllTime: number;
  recentReviews: Review[];
  costByDay: { date: string; cost: number }[];
  findingsByCategory: { category: string; critical: number; warning: number; info: number }[];
}
