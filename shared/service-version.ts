export interface VersionCheckError {
  kind: 'timeout' | 'dns' | 'tls' | 'connection' | 'http' | 'rate-limit' | 'invalid-response' | 'unknown';
  stage: 'revision' | 'manifest' | 'comparison';
  httpStatus?: number;
  code?: string;
  retryAt?: string;
}

export interface RepositoryVersionStatus {
  currentVersion: string;
  currentCommit: string | null;
  localChanges: boolean;
  repositoryVersion: string | null;
  repositoryCommit: string | null;
  updateAvailable: boolean | null;
  checkedAt: string | null;
  stale: boolean;
  status: 'current' | 'available' | 'unavailable';
  attemptedAt?: string | null;
  nextCheckAt?: string | null;
  nextManualCheckAt?: string | null;
  lastError?: VersionCheckError | null;
}
