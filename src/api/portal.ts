/**
 * Portal static file serving — admin portal at /portal and /config.
 *
 * Serves files from src/portal/ with mime-type detection and traversal protection.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const PORTAL_DIR = new URL('../portal/', import.meta.url);
const PORTAL_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

/**
 * Serve a portal static file. Returns true if the file was served, false on miss
 * (caller should fall through to 404).
 */
export function servePortalFile(res: http.ServerResponse, filePath: string): boolean {
  const ext = path.extname(filePath);
  const mime = PORTAL_MIME[ext];
  if (!mime) return false;

  // Resolve relative to portal dir, prevent traversal
  const resolved = new URL(filePath, PORTAL_DIR);
  if (!resolved.pathname.startsWith(new URL('.', PORTAL_DIR).pathname)) return false;

  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}
