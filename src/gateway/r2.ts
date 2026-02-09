import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

/**
 * R2 prefix → container directory mapping.
 *
 * Note: skills/ is NOT restored here because seed skills are already baked
 * into the Docker image (COPY skills/ /root/clawd/skills/). Restoring
 * hundreds of skill files would exhaust subrequests and delay startup.
 */
const RESTORE_PREFIXES: Record<string, string> = {
  'openclaw/': '/root/.openclaw',
  'workspace/': '/root/clawd',
};

/**
 * Files to skip during restore — these are large, numerous, and not needed
 * for bot identity/config restoration. Skipping them keeps us well under
 * the Cloudflare 1000 subrequest limit per worker invocation.
 */
const SKIP_EXTENSIONS = ['.jsonl', '.bak'];

/**
 * Check if an R2 key should be skipped during restore.
 */
function shouldSkipKey(key: string): boolean {
  // Directory markers (keys ending with /)
  if (key.endsWith('/')) return true;
  // Session logs and backup files
  if (SKIP_EXTENSIONS.some((ext) => key.includes(ext))) return true;
  // Corrupted keys from buggy SSE-based sync (contain JSON/SSE fragments)
  if (key.includes('"') || key.includes('{') || key.includes('\\n')) return true;
  return false;
}

/**
 * Restore files from R2 bucket directly into the container.
 *
 * Reads objects from R2 via the worker-side bucket binding and writes them
 * into the sandbox using sandbox.writeFile(). This replaces the old s3fs
 * mount approach which was flaky and caused identity loss on startup.
 *
 * Skips session logs (.jsonl) and backup files (.bak) to stay under the
 * Cloudflare 1000 subrequest limit per worker invocation.
 */
export async function restoreFromR2(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  if (!env.MOLTBOT_BUCKET) {
    console.log('R2 bucket binding not configured, skipping restore');
    return false;
  }

  // Check if any backup exists by looking for .last-sync marker
  const lastSyncObj = await env.MOLTBOT_BUCKET.get('.last-sync');
  if (!lastSyncObj) {
    console.log('No .last-sync found in R2, skipping restore (first-time setup)');
    return false;
  }

  const lastSync = await lastSyncObj.text();
  console.log('R2 last sync:', lastSync);

  let totalFiles = 0;

  for (const [prefix, containerDir] of Object.entries(RESTORE_PREFIXES)) {
    try {
      const count = await restorePrefix(sandbox, env, prefix, containerDir);
      totalFiles += count;
    } catch (err) {
      console.error(`Failed to restore prefix ${prefix}:`, err);
    }
  }

  if (totalFiles > 0) {
    // Write .last-sync into the config dir so the shell script knows data was restored
    try {
      await sandbox.writeFile('/root/.openclaw/.last-sync', lastSync);
    } catch {
      // Non-critical
    }
    console.log(`Restored ${totalFiles} files from R2`);
    return true;
  }

  console.log('No files found in R2 to restore');
  return false;
}

/**
 * Restore all objects under a given R2 prefix into a container directory.
 */
async function restorePrefix(
  sandbox: Sandbox,
  env: MoltbotEnv,
  prefix: string,
  containerDir: string,
): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  const createdDirs = new Set<string>();

  // Ensure the target directory exists
  await mkdirCached(sandbox, containerDir, createdDirs);

  do {
    const listResult = await env.MOLTBOT_BUCKET.list({
      prefix,
      cursor,
    });

    for (const obj of listResult.objects) {
      if (shouldSkipKey(obj.key)) continue;

      try {
        const relativePath = obj.key.slice(prefix.length);
        if (!relativePath) continue;

        const containerPath = `${containerDir}/${relativePath}`;

        // Ensure parent directory exists (cached to avoid redundant calls)
        const lastSlash = containerPath.lastIndexOf('/');
        if (lastSlash > 0) {
          await mkdirCached(sandbox, containerPath.slice(0, lastSlash), createdDirs);
        }

        const r2Obj = await env.MOLTBOT_BUCKET.get(obj.key);
        if (!r2Obj) continue;

        const content = await r2Obj.text();
        await sandbox.writeFile(containerPath, content);
        count++;
      } catch (err) {
        console.log(`Failed to restore ${obj.key}:`, err);
      }
    }

    cursor = listResult.truncated ? listResult.cursor : undefined;
  } while (cursor);

  if (count > 0) {
    console.log(`Restored ${count} files from R2 prefix ${prefix} → ${containerDir}`);
  }

  return count;
}

/**
 * Create a directory only if we haven't already created it this session.
 */
async function mkdirCached(sandbox: Sandbox, dir: string, cache: Set<string>): Promise<void> {
  if (cache.has(dir)) return;
  try {
    await sandbox.mkdir(dir, { recursive: true });
  } catch {
    // May already exist
  }
  cache.add(dir);
}
