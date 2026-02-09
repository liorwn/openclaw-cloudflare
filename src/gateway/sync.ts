import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 *
 * Uses sandbox file APIs (readFileStream, execStream) to read files directly
 * from the container, then writes to R2 via the worker-side bucket binding.
 *
 * This avoids sandbox.mountBucket() (hangs indefinitely — Cloudflare SDK bug)
 * and sandbox.getLogs() (often returns empty stdout — another SDK bug).
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  if (!env.MOLTBOT_BUCKET) {
    return { success: false, error: 'R2 bucket binding not configured' };
  }

  // Determine which config directory exists
  let configDir: string | null = null;
  try {
    const files = await listContainerFiles(sandbox, '/root/.openclaw');
    if (files.length > 0) configDir = '/root/.openclaw';
  } catch {
    // Directory doesn't exist or isn't accessible
  }

  if (!configDir) {
    try {
      const files = await listContainerFiles(sandbox, '/root/.clawdbot');
      if (files.length > 0) configDir = '/root/.clawdbot';
    } catch {
      // Directory doesn't exist or isn't accessible
    }
  }

  if (!configDir) {
    return {
      success: false,
      error: 'Nothing to sync',
      details:
        'No config directory found in the container. Pair a device first to generate config.',
    };
  }

  // Clean up corrupted R2 keys from previous buggy SSE-based sync
  await cleanCorruptedR2Keys(env);

  try {
    let totalFiles = 0;

    // Sync config directory
    const configFiles = await syncDirectory(sandbox, env, configDir, 'openclaw');
    totalFiles += configFiles;

    // Sync workspace directory (excluding skills subdirectory)
    try {
      const workspaceFiles = await syncDirectory(sandbox, env, '/root/clawd', 'workspace', [
        'skills',
      ]);
      totalFiles += workspaceFiles;
    } catch {
      // Workspace might not exist yet
    }

    // Sync skills directory
    try {
      const skillsFiles = await syncDirectory(sandbox, env, '/root/clawd/skills', 'skills');
      totalFiles += skillsFiles;
    } catch {
      // Skills might not exist yet
    }

    if (totalFiles > 0) {
      const now = new Date().toISOString();
      await env.MOLTBOT_BUCKET.put('.last-sync', now);
      return {
        success: true,
        lastSync: now,
        details: `Synced ${totalFiles} files to R2 (direct file transfer)`,
      };
    }

    return {
      success: false,
      error: 'Nothing to sync',
      details: 'Config directory exists but contained no syncable files.',
    };
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Read a stream fully into a string using TextDecoder.
 */
async function readStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let raw = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += new TextDecoder().decode(value);
  }
  return raw;
}

/**
 * Parse SSE-formatted stream output from Cloudflare sandbox APIs.
 * Both execStream and readFileStream return SSE events: "data: {JSON}\n\n"
 * Returns parsed JSON objects from each event.
 */
function parseSSEEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of raw.split('\n\n')) {
    const line = block.trim();
    if (!line) continue;
    const jsonStr = line.startsWith('data: ') ? line.slice(6) : line;
    try {
      events.push(JSON.parse(jsonStr));
    } catch {
      // Skip unparseable blocks
    }
  }
  return events;
}

/**
 * Check if a filesystem path is clean (not a corrupted SSE fragment).
 * Previous buggy restore created files with SSE data in their names.
 * These paths contain fragments like 'tdout', 'omplete', 'timestamp', 'exitCode', etc.
 */
function isCleanPath(path: string): boolean {
  // Check for common corruption indicators
  if (path.includes('"') || path.includes('{') || path.includes('}')) return false;
  if (path.includes('\\n') || path.includes('\\\\')) return false;
  if (path.includes('timestamp') && path.includes('data')) return false;
  if (path.includes('tdout') || path.includes('omplete')) return false;
  if (path.includes('exitCode')) return false;
  return true;
}

/**
 * List files in a container directory using execStream.
 * Excludes lock, log, and tmp files.
 *
 * execStream returns SSE events: "data: {"type":"stdout","data":"path1\npath2\n"}\n\n"
 * We split by double-newline (SSE separator), parse JSON, and extract paths.
 */
async function listContainerFiles(
  sandbox: Sandbox,
  dirPath: string,
  excludeDirs: string[] = [],
): Promise<string[]> {
  const excludeArgs = excludeDirs.map((d) => `-not -path "*/${d}/*"`).join(' ');

  const cmd = `find ${dirPath} -type f ${excludeArgs} -not -path "*/.git/*" -not -name "*.lock" -not -name "*.log" -not -name "*.tmp" 2>/dev/null || true`;

  const raw = await readStreamToString(await sandbox.execStream(cmd));
  const events = parseSSEEvents(raw);
  const files: string[] = [];

  for (const evt of events) {
    if (evt.type === 'stdout' && typeof evt.data === 'string') {
      for (const path of evt.data.trim().split('\n')) {
        if (path && path.startsWith('/') && isCleanPath(path)) files.push(path);
      }
    }
  }

  return files;
}

/**
 * Sync a container directory to R2 by reading each file and uploading it.
 * Returns the count of synced files.
 *
 * readFileStream returns SSE events:
 *   data: {"type":"metadata","mimeType":"...","size":N,"isBinary":false,...}
 *   data: {"type":"chunk","data":"<file content>"}
 *   data: {"type":"complete","bytesRead":N}
 * We extract only the "chunk" data to get the actual file content.
 */
async function syncDirectory(
  sandbox: Sandbox,
  env: MoltbotEnv,
  containerDir: string,
  r2Prefix: string,
  excludeDirs: string[] = [],
): Promise<number> {
  const files = await listContainerFiles(sandbox, containerDir, excludeDirs);
  let count = 0;

  for (const filePath of files) {
    try {
      const relativePath = filePath.slice(containerDir.length + 1);
      const r2Key = `${r2Prefix}/${relativePath}`;

      const raw = await readStreamToString(await sandbox.readFileStream(filePath));
      const events = parseSSEEvents(raw);

      // Extract file content from chunk events
      let fileContent = '';
      for (const evt of events) {
        if (evt.type === 'chunk' && typeof evt.data === 'string') {
          fileContent += evt.data;
        }
      }

      if (fileContent) {
        await env.MOLTBOT_BUCKET.put(r2Key, fileContent);
        count++;
      }
    } catch (err) {
      console.log(`Failed to sync file ${filePath}:`, err);
    }
  }

  return count;
}

/**
 * Delete corrupted R2 keys that were created by a previous buggy SSE-based sync.
 * These keys contain JSON/SSE fragments in their names (e.g. quotes, braces, newlines).
 */
async function cleanCorruptedR2Keys(env: MoltbotEnv): Promise<void> {
  let cursor: string | undefined;
  let deleted = 0;

  do {
    const list = await env.MOLTBOT_BUCKET.list({ cursor });

    for (const obj of list.objects) {
      if (obj.key.includes('"') || obj.key.includes('{') || obj.key.includes('\\n')) {
        try {
          await env.MOLTBOT_BUCKET.delete(obj.key);
          deleted++;
        } catch {
          // Best-effort cleanup
        }
      }
    }

    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} corrupted R2 keys`);
  }
}
