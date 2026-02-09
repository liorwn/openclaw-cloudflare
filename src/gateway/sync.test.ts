import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncToR2 } from './sync';
import { createMockEnv, suppressConsole } from '../test-utils';
import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

/**
 * Create a mock ReadableStream from a string
 */
function mockStream(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

/**
 * Build SSE-formatted output like the sandbox APIs return
 */
function sseStdout(data: string): string {
  return `data: ${JSON.stringify({ type: 'stdout', data })}\n\n`;
}

function sseChunk(data: string): string {
  return `data: ${JSON.stringify({ type: 'chunk', data })}\n\n`;
}

function sseMetadata(): string {
  return `data: ${JSON.stringify({ type: 'metadata', mimeType: 'text/plain', size: 100, isBinary: false })}\n\n`;
}

function sseComplete(): string {
  return `data: ${JSON.stringify({ type: 'complete', bytesRead: 100 })}\n\n`;
}

/**
 * Create a mock sandbox with execStream and readFileStream
 */
function createSyncMockSandbox() {
  const execStreamMock = vi.fn();
  const readFileStreamMock = vi.fn();

  const sandbox = {
    execStream: execStreamMock,
    readFileStream: readFileStreamMock,
    mountBucket: vi.fn(),
    listProcesses: vi.fn().mockResolvedValue([]),
    startProcess: vi.fn(),
    containerFetch: vi.fn(),
    wsConnect: vi.fn(),
  } as unknown as Sandbox;

  return { sandbox, execStreamMock, readFileStreamMock };
}

/**
 * Create a mock env with a real-looking MOLTBOT_BUCKET mock
 */
function createMockEnvWithBucket(): MoltbotEnv {
  const bucket = {
    put: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return createMockEnv({
    MOLTBOT_BUCKET: bucket as any,
  });
}

describe('syncToR2', () => {
  beforeEach(() => {
    suppressConsole();
  });

  describe('configuration checks', () => {
    it('returns error when R2 bucket binding is not configured', async () => {
      const { sandbox } = createSyncMockSandbox();
      const env = createMockEnv({
        MOLTBOT_BUCKET: undefined as any,
      });

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('R2 bucket binding not configured');
    });
  });

  describe('directory detection', () => {
    it('returns "Nothing to sync" when no config directory exists', async () => {
      const { sandbox, execStreamMock } = createSyncMockSandbox();
      const env = createMockEnvWithBucket();

      // Both find commands return empty (no files in either directory)
      execStreamMock.mockResolvedValue(mockStream(sseStdout('')));

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Nothing to sync');
    });

    it('detects /root/.openclaw config directory', async () => {
      const { sandbox, execStreamMock, readFileStreamMock } = createSyncMockSandbox();
      const env = createMockEnvWithBucket();

      // Call flow:
      // 1. listContainerFiles('/root/.openclaw') — detection
      // 2. cleanCorruptedR2Keys — uses bucket.list (mocked above)
      // 3. syncDirectory config: listContainerFiles('/root/.openclaw') again
      // 4. syncDirectory workspace: listContainerFiles('/root/clawd', ['skills'])
      // 5. syncDirectory skills: listContainerFiles('/root/clawd/skills')
      execStreamMock
        // Detection: has files
        .mockResolvedValueOnce(mockStream(sseStdout('/root/.openclaw/openclaw.json\n')))
        // syncDirectory config: list files again
        .mockResolvedValueOnce(mockStream(sseStdout('/root/.openclaw/openclaw.json\n')))
        // syncDirectory workspace: empty
        .mockResolvedValueOnce(mockStream(sseStdout('')))
        // syncDirectory skills: empty
        .mockResolvedValueOnce(mockStream(sseStdout('')));

      // readFileStream for the one config file
      readFileStreamMock.mockResolvedValueOnce(
        mockStream(sseMetadata() + sseChunk('{"gateway":{}}') + sseComplete()),
      );

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.lastSync).toBeDefined();
    });
  });

  describe('sync execution', () => {
    it('syncs files to R2 and returns success', async () => {
      const { sandbox, execStreamMock, readFileStreamMock } = createSyncMockSandbox();
      const env = createMockEnvWithBucket();

      execStreamMock
        // Detection: /root/.openclaw has files
        .mockResolvedValueOnce(
          mockStream(sseStdout('/root/.openclaw/openclaw.json\n/root/.openclaw/state.json\n')),
        )
        // syncDirectory config: list files again
        .mockResolvedValueOnce(
          mockStream(sseStdout('/root/.openclaw/openclaw.json\n/root/.openclaw/state.json\n')),
        )
        // syncDirectory workspace: one file
        .mockResolvedValueOnce(mockStream(sseStdout('/root/clawd/IDENTITY.md\n')))
        // syncDirectory skills: empty
        .mockResolvedValueOnce(mockStream(sseStdout('')));

      // readFileStream for each file
      readFileStreamMock
        .mockResolvedValueOnce(
          mockStream(sseMetadata() + sseChunk('{"gateway":{}}') + sseComplete()),
        )
        .mockResolvedValueOnce(
          mockStream(sseMetadata() + sseChunk('{"state":"ok"}') + sseComplete()),
        )
        .mockResolvedValueOnce(
          mockStream(sseMetadata() + sseChunk('# Identity') + sseComplete()),
        );

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.details).toContain('3 files');

      // Verify R2 puts were called
      const bucket = env.MOLTBOT_BUCKET as any;
      expect(bucket.put).toHaveBeenCalledWith('openclaw/openclaw.json', '{"gateway":{}}');
      expect(bucket.put).toHaveBeenCalledWith('openclaw/state.json', '{"state":"ok"}');
      expect(bucket.put).toHaveBeenCalledWith('workspace/IDENTITY.md', '# Identity');
    });

    it('handles read errors gracefully and continues', async () => {
      const { sandbox, execStreamMock, readFileStreamMock } = createSyncMockSandbox();
      const env = createMockEnvWithBucket();

      execStreamMock
        // Detection
        .mockResolvedValueOnce(
          mockStream(sseStdout('/root/.openclaw/openclaw.json\n/root/.openclaw/other.json\n')),
        )
        // syncDirectory config: list files
        .mockResolvedValueOnce(
          mockStream(sseStdout('/root/.openclaw/openclaw.json\n/root/.openclaw/other.json\n')),
        )
        // syncDirectory workspace: empty
        .mockResolvedValueOnce(mockStream(sseStdout('')))
        // syncDirectory skills: empty
        .mockResolvedValueOnce(mockStream(sseStdout('')));

      // First file succeeds, second throws
      readFileStreamMock
        .mockResolvedValueOnce(
          mockStream(sseMetadata() + sseChunk('{"config":true}') + sseComplete()),
        )
        .mockRejectedValueOnce(new Error('File not found'));

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.details).toContain('1 files');
    });
  });
});
