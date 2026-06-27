import type { ProjectionMode } from './bankProjection';

const KEY = 'hon.projectionMode';

/** The persisted projection-picker choice; defaults to 'committed'. */
export function loadProjectionMode(): ProjectionMode {
  try {
    return window.localStorage.getItem(KEY) === 'budget' ? 'budget' : 'committed';
  } catch {
    return 'committed';
  }
}

export function saveProjectionMode(mode: ProjectionMode): void {
  try { window.localStorage.setItem(KEY, mode); } catch { /* ignore */ }
}
