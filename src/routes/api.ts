import type { Sandbox } from '@cloudflare/sandbox';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import {
  ensureMoltbotGateway,
  findExistingMoltbotProcess,
  syncToR2,
} from '../gateway';

// CLI commands timeout
const CLI_TIMEOUT_MS = 15000;
const DONE_MARKER = '__EXEC_DONE__';

/**
 * Read a file from the sandbox with a timeout.
 * Returns null if the file doesn't exist or read times out.
 */
async function readFile(sandbox: Sandbox, path: string, timeoutMs: number = 3000): Promise<string | null> {
  try {
    const result = await Promise.race([
      (async () => {
        const stream = await sandbox.readFileStream(path);
        const reader = stream.getReader();
        let out = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) out += new TextDecoder().decode(value);
        }
        return out;
      })(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return result;
  } catch {
    return null;
  }
}

/**
 * Run a command in the sandbox and return its output.
 *
 * Uses startProcess + readFileStream instead of execStream or getLogs,
 * both of which hang indefinitely (Cloudflare Sandbox SDK bugs).
 */
async function execCommand(
  sandbox: Sandbox,
  cmd: string,
  timeoutMs: number = CLI_TIMEOUT_MS,
): Promise<string> {
  const tag = Date.now();
  const outFile = `/tmp/exec-${tag}.out`;

  // Escape single quotes for sh -c '...'
  const escaped = cmd.replace(/'/g, "'\\''");
  // Start process: run cmd with `timeout`, write output + done marker to file
  const shellCmd = `sh -c 'timeout 12 ${escaped} > ${outFile} 2>&1; echo ${DONE_MARKER} >> ${outFile}'`;
  console.log('[execCommand] Calling startProcess...');
  await sandbox.startProcess(shellCmd);
  console.log('[execCommand] startProcess returned OK');

  // Wait for the command to complete, then read the output file
  // Use a simple wait + read approach (polling readFileStream can hang on non-existent files)
  const waitMs = Math.min(timeoutMs - 2000, 10000);
  console.log('[execCommand] Waiting', waitMs, 'ms for command to finish...');
  await new Promise((r) => setTimeout(r, waitMs));

  console.log('[execCommand] Reading output file...');
  const content = await readFile(sandbox, outFile, 5000);
  console.log('[execCommand] readFile returned:', content === null ? 'null' : `${content.length} bytes`);

  if (content !== null && content.includes(DONE_MARKER)) {
    return content.replace(DONE_MARKER, '').trim();
  }

  // Command not done yet - wait a bit more and try again
  if (content === null || !content.includes(DONE_MARKER)) {
    console.log('[execCommand] Not done yet, waiting 3s more...');
    await new Promise((r) => setTimeout(r, 3000));
    const retry = await readFile(sandbox, outFile, 5000);
    console.log('[execCommand] Retry readFile:', retry === null ? 'null' : `${retry.length} bytes`);
    if (retry !== null) {
      return retry.replace(DONE_MARKER, '').trim();
    }
  }

  return content?.replace(DONE_MARKER, '').trim() ?? '';
}

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 *
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// Hard timeout for the entire devices endpoint (prevents blocking DO)
const DEVICES_TIMEOUT_MS = 20000;

/**
 * Kill orphaned processes in the sandbox to stay under process limits.
 * Keeps only the gateway process alive.
 */
async function cleanupOrphanedProcesses(sandbox: Sandbox): Promise<number> {
  try {
    const processes = await sandbox.listProcesses();
    if (processes.length <= 5) return 0; // No cleanup needed

    console.log('[cleanup] Found', processes.length, 'processes, cleaning up...');
    let killed = 0;

    for (const proc of processes) {
      // Keep the gateway process alive
      const isGateway =
        proc.command.includes('start-openclaw.sh') ||
        proc.command.includes('openclaw gateway') ||
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');

      if (!isGateway && (proc.status === 'running' || proc.status === 'starting')) {
        try {
          await proc.kill();
          killed++;
        } catch {
          // Ignore kill errors
        }
      }
    }
    console.log('[cleanup] Killed', killed, 'orphaned processes');
    return killed;
  } catch (e) {
    console.error('[cleanup] Error:', e);
    return 0;
  }
}

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  const handler = async () => {
    console.log('[devices] Handler started');

    // Ensure moltbot is running first
    console.log('[devices] Calling ensureMoltbotGateway...');
    await ensureMoltbotGateway(sandbox, c.env);
    console.log('[devices] Gateway ready');

    // Clean up orphaned processes first (too many processes causes startProcess to hang)
    await cleanupOrphanedProcesses(sandbox);

    // Run OpenClaw CLI to list devices
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const cmd = `openclaw devices list --json --url ws://localhost:18789${tokenArg}`;
    console.log('[devices] Running execCommand...');
    const stdout = await execCommand(sandbox, cmd);
    console.log('[devices] execCommand returned, output length:', stdout.length);

    // Try to parse JSON output
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through
      }
    }
    return { pending: [], paired: [], raw: stdout || 'No output from CLI' };
  };

  try {
    const result = await Promise.race([
      handler(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Devices endpoint timed out')), DEVICES_TIMEOUT_MS),
      ),
    ]);
    return c.json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[devices] Error:', errorMessage);
    return c.json({ error: errorMessage, pending: [], paired: [] }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run OpenClaw CLI to approve the device using execStream (avoids getLogs hang bug)
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const stdout = await execCommand(
      sandbox,
      `openclaw devices approve ${requestId} --url ws://localhost:18789${tokenArg}`,
    );

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved');

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices using execStream (avoids getLogs hang bug)
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const stdout = await execCommand(
      sandbox,
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
    );

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential device approval required
        const approveOutput = await execCommand(
          sandbox,
          `openclaw devices approve ${device.requestId} --url ws://localhost:18789${tokenArg}`,
        );
        const success = approveOutput.toLowerCase().includes('approved');

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter((r) => r.success).length;
    return c.json({
      approved: results.filter((r) => r.success).map((r) => r.requestId),
      failed: results.filter((r) => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID &&
    c.env.R2_SECRET_ACCESS_KEY &&
    c.env.CF_ACCOUNT_ID
  );

  // Check which credentials are missing
  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;

  // If R2 is configured, check for last sync timestamp directly from R2 bucket
  if (hasCredentials) {
    try {
      const tsObj = await c.env.MOLTBOT_BUCKET.get('.last-sync');
      if (tsObj) {
        const timestamp = (await tsObj.text()).trim();
        if (timestamp) {
          lastSync = timestamp;
        }
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');

  const result = await syncToR2(sandbox, c.env);

  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes('not configured') ? 400 : 500;
    return c.json(
      {
        success: false,
        error: result.error,
        details: result.details,
      },
      status,
    );
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Find and kill the existing gateway process
    const existingProcess = await findExistingMoltbotProcess(sandbox);

    if (existingProcess) {
      console.log('Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('Error killing process:', killErr);
      }
      // Wait a moment for the process to die
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Start a new gateway in the background
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
