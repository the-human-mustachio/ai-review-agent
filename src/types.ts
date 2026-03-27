export interface Issue {
  severity: 'blocking' | 'warning' | 'info';
  message: string;
  file: string;
  line: number;
  endLine?: number;
}

export interface Review {
  approve: boolean;
  summary: string;
  issues: Issue[];
  recommendation: string;
  prSummary?: string;
}

export interface PrMetadata {
  prNumber: string | number;
  prTitle: string;
  prAuthor: string;
  prBody: string;
  baseBranch: string;
}

export interface ReviewOptions {
  baseBranch: string;
  prTitle: string;
  prAuthor: string;
  prBody: string;
  prNumber: string | number;
  mode?: 'quick' | 'agentic';
  summary?: boolean;
  promptPath?: string;
  rulesPath?: string;
  excludePatterns?: string;
  maxDiffSize?: number;
  opencodeConfig?: string;
  apiKey?: string;
  provider?: string;
  model?: string;
  log?: (...args: unknown[]) => void;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
  start_line?: number;
}

export interface FileDiff {
  file: string;
  diff: string;
}

export interface HunkContext {
  file: string;
  content: string;
}

export interface Chunk {
  files: string[];
  diff: string;
}

export interface Platform {
  detect: () => boolean;
  getPrMetadata: (token?: string) => Promise<PrMetadata>;
  postReview: (review: Review, opts: PostReviewOptions) => Promise<void>;
}

export interface PostReviewOptions {
  prNumber: string | number;
  token: string;
  postReview?: boolean;
  log?: (...args: unknown[]) => void;
}
