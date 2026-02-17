/**
 * E2E Test for Recurse Splitter Worker
 *
 * Tests the recursive splitting logic by:
 * 1. Creating an entity with text that needs multiple splits
 * 2. Invoking the klados directly (not via rhiza workflow)
 * 3. Manually simulating recursion by re-invoking when done=false
 * 4. Verifying the entity has the expected final state
 *
 * NOTE: The Arke API doesn't yet support the 'recurse' handoff type,
 * so we test the worker logic directly instead of via a workflow.
 *
 * Environment variables:
 *   ARKE_USER_KEY   - Your Arke user API key (uk_...)
 *   KLADOS_ID       - The klados worker ID from registration
 *   ARKE_API_BASE   - API base URL (default: https://arke-v1.arke.institute)
 *   ARKE_NETWORK    - Network to use (default: test)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  configureTestClient,
  createCollection,
  createEntity,
  getEntity,
  deleteEntity,
  invokeKlados,
  waitForKladosLog,
  assertLogCompleted,
  log,
} from '@arke-institute/klados-testing';

// =============================================================================
// Configuration
// =============================================================================

const ARKE_API_BASE = process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute';
const ARKE_USER_KEY = process.env.ARKE_USER_KEY;
const NETWORK = (process.env.ARKE_NETWORK || 'test') as 'test' | 'main';
const KLADOS_ID = process.env.KLADOS_ID;

// =============================================================================
// Test Suite
// =============================================================================

describe('recurse-splitter worker', () => {
  let targetCollection: { id: string };
  let testEntity: { id: string };

  // Skip tests if environment not configured
  beforeAll(() => {
    if (!ARKE_USER_KEY) {
      console.warn('Skipping tests: ARKE_USER_KEY not set');
      return;
    }
    if (!KLADOS_ID) {
      console.warn('Skipping tests: KLADOS_ID not set');
      return;
    }

    configureTestClient({
      apiBase: ARKE_API_BASE,
      userKey: ARKE_USER_KEY,
      network: NETWORK,
    });
  });

  // Create test fixtures
  beforeAll(async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    log('Creating test fixtures...');

    // Create target collection
    targetCollection = await createCollection({
      label: `Recurse Test ${Date.now()}`,
      description: 'Target collection for recurse splitter test',
    });
    log(`Created target collection: ${targetCollection.id}`);
  });

  // Cleanup test fixtures
  afterAll(async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    log('Cleaning up test fixtures...');

    try {
      if (testEntity?.id) await deleteEntity(testEntity.id);
      if (targetCollection?.id) await deleteEntity(targetCollection.id);
      log('Cleanup complete');
    } catch (e) {
      log(`Cleanup error (non-fatal): ${e}`);
    }
  });

  // ==========================================================================
  // Helper: invoke and wait for completion, check entity state for termination
  // ==========================================================================

  async function invokeAndWait(entityId: string, prevSplitCount: number | undefined): Promise<{
    done: boolean;
    logData: unknown;
    splitCount: number | undefined;
  }> {
    const result = await invokeKlados({
      kladosId: KLADOS_ID!,
      targetEntity: entityId,
      targetCollection: targetCollection.id,
      confirm: true,
    });

    expect(result.status).toBe('started');
    const jobCollectionId = result.job_collection!;

    // Wait for completion
    const kladosLog = await waitForKladosLog(jobCollectionId, {
      timeout: 30000,
      pollInterval: 2000,
    });

    assertLogCompleted(kladosLog);

    // Check entity state to determine if done
    // If split_count hasn't increased, we're done (no more splitting needed)
    const entity = await getEntity(entityId);
    const splitCount = entity.properties.split_count as number | undefined;
    const done = splitCount === prevSplitCount;  // No new splits means done

    return { done, logData: kladosLog.properties.log_data, splitCount };
  }

  // ==========================================================================
  // Tests
  // ==========================================================================

  it('should recursively split text until segments are small enough', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // Create entity with 80-character text
    // This should require 3 iterations to get to 10-char segments:
    // Iteration 0: 80 -> 40 + 40 = 2 segments
    // Iteration 1: 40 -> 20 + 20 (x2) = 4 segments
    // Iteration 2: 20 -> 10 + 10 (x4) = 8 segments (all <= 10, done)
    const TEXT_LENGTH = 80;
    testEntity = await createEntity({
      type: 'test_splitter_entity',
      properties: {
        text: 'A'.repeat(TEXT_LENGTH),
        label: 'Recurse Test Entity',
      },
      collection: targetCollection.id,
    });
    log(`Created test entity: ${testEntity.id} with ${TEXT_LENGTH} chars`);

    // Manually simulate recursion by re-invoking until no more splits
    let iterationCount = 0;
    let prevSplitCount: number | undefined = undefined;
    const MAX_ITERATIONS = 20; // Safety limit

    while (iterationCount < MAX_ITERATIONS) {
      log(`\nIteration ${iterationCount}...`);
      const { done, logData, splitCount } = await invokeAndWait(testEntity.id, prevSplitCount);

      // Log messages from this iteration
      const messages = (logData as { messages?: Array<{ level: string; message: string }> })?.messages ?? [];
      for (const msg of messages) {
        log(`  [${msg.level}] ${msg.message}`);
      }

      iterationCount++;
      prevSplitCount = splitCount;

      if (done) {
        log(`\nCompleted after ${iterationCount} iterations (split_count stabilized at ${splitCount})`);
        break;
      }
    }

    // Should have completed in exactly 4 iterations:
    // Iterations 1-3 do splits, iteration 4 detects no new splits needed
    expect(iterationCount).toBe(4);

    // Verify final entity state
    const finalEntity = await getEntity(testEntity.id);
    const segments = finalEntity.properties.segments as string[];
    const splitCount = finalEntity.properties.split_count as number;
    const lastSplitDepth = finalEntity.properties.last_split_depth as number;

    log(`\nFinal state: ${segments.length} segments, ${splitCount} splits, last depth ${lastSplitDepth}`);

    // Should have 8 segments (2^3 = 8)
    expect(segments).toHaveLength(8);

    // Each segment should be 10 characters
    for (const segment of segments) {
      expect(segment.length).toBe(10);
      expect(segment).toBe('A'.repeat(10));
    }

    // Should have done 3 splits (one per iteration that did work)
    expect(splitCount).toBe(3);

    // Note: lastSplitDepth is always 0 when invoking klados directly (outside workflow)
    // because recurseDepth is only tracked when invoked via rhiza workflow handoffs.
    // In a real workflow with recurse handoff, this would be 2 (0-indexed).
    expect(lastSplitDepth).toBe(0);  // Direct invocation = no depth tracking
  });

  it('should handle single iteration when text is already small', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // Create entity with already-small text (10 chars or less)
    const smallEntity = await createEntity({
      type: 'test_splitter_entity',
      properties: {
        text: 'SMALL',  // 5 characters
        label: 'Small Test Entity',
      },
      collection: targetCollection.id,
    });
    log(`Created small entity: ${smallEntity.id} with 5 chars`);

    try {
      // Should complete in single iteration (no splits needed)
      const { logData, splitCount } = await invokeAndWait(smallEntity.id, undefined);

      // Log messages
      const messages = (logData as { messages?: Array<{ level: string; message: string }> })?.messages ?? [];
      for (const msg of messages) {
        log(`  [${msg.level}] ${msg.message}`);
      }

      // Verify entity state - no splitting should have occurred
      const finalEntity = await getEntity(smallEntity.id);
      const segments = finalEntity.properties.segments as string[] | undefined;
      const finalSplitCount = finalEntity.properties.split_count as number | undefined;

      // No splitting should have occurred
      expect(segments).toBeUndefined();  // Worker doesn't create segments if already done
      expect(finalSplitCount).toBeUndefined();
      expect(splitCount).toBeUndefined();

      log('Single iteration test passed');
    } finally {
      await deleteEntity(smallEntity.id);
    }
  });

  it('should correctly split larger text', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // Create entity with 320-character text
    // This should require 5 splits:
    // 320 -> 160+160 -> 80x4 -> 40x8 -> 20x16 -> 10x32 (done)
    // Total iterations: 5 splits + 1 check = 6
    const TEXT_LENGTH = 320;
    const largeEntity = await createEntity({
      type: 'test_splitter_entity',
      properties: {
        text: 'B'.repeat(TEXT_LENGTH),
        label: 'Large Test Entity',
      },
      collection: targetCollection.id,
    });
    log(`Created large entity: ${largeEntity.id} with ${TEXT_LENGTH} chars`);

    try {
      let iterationCount = 0;
      let prevSplitCount: number | undefined = undefined;
      const MAX_ITERATIONS = 20;

      while (iterationCount < MAX_ITERATIONS) {
        log(`Iteration ${iterationCount}...`);
        const { done, splitCount } = await invokeAndWait(largeEntity.id, prevSplitCount);
        iterationCount++;
        prevSplitCount = splitCount;

        if (done) {
          log(`Completed after ${iterationCount} iterations`);
          break;
        }
      }

      // Should have completed in 6 iterations (5 splits + 1 check)
      expect(iterationCount).toBe(6);

      // Verify final state
      const finalEntity = await getEntity(largeEntity.id);
      const segments = finalEntity.properties.segments as string[];

      // Should have 32 segments (2^5 = 32)
      expect(segments).toHaveLength(32);

      // Each segment should be 10 characters
      for (const segment of segments) {
        expect(segment.length).toBe(10);
      }

      log('Large text test passed');
    } finally {
      await deleteEntity(largeEntity.id);
    }
  }, 180000);  // Increase timeout for this test
});
