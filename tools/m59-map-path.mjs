// One map-selection policy for every broker launch path.
//
// Setup bakes server-matched collision data into a gitignored local artifact. A
// service restart, foreground broker, and diagnostic CLI must all keep using that
// artifact; silently falling back to the portable reference map can make every move
// fail its room-security check after an otherwise healthy restart.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKED_MAP_FILE = path.join(REPO, 'substrate', 'm59-map.json');
export const LOCAL_MAP_FILE = path.join(REPO, 'substrate', 'm59-map.local.json');

export function movementMapFile({ explicit = process.env.M59_MAP, exists = existsSync } = {}) {
  if (explicit) return path.resolve(explicit);
  return exists(LOCAL_MAP_FILE) ? LOCAL_MAP_FILE : CHECKED_MAP_FILE;
}

// Build/refresh is maintenance, not runtime selection. A bare refresh updates the
// committed reference; an explicit M59_MAP writes exactly there.
export function geometryOutputFile({ explicit = process.env.M59_MAP } = {}) {
  return explicit ? path.resolve(explicit) : CHECKED_MAP_FILE;
}

// A setup-local refresh always starts from the current committed graph. Otherwise an
// old local artifact can preserve obsolete exits forever while only its geometry is
// replaced. Custom explicit map destinations retain their own graph by design.
export function geometryRefreshBaseFile(output, { exists = existsSync } = {}) {
  const resolved = path.resolve(output);
  if (resolved === path.resolve(LOCAL_MAP_FILE)) return CHECKED_MAP_FILE;
  return exists(resolved) ? resolved : CHECKED_MAP_FILE;
}
