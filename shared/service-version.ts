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
}
