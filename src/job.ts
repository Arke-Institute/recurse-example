/**
 * Splitter Job Processing Logic
 *
 * Recursively splits text segments until they are below a threshold.
 * Demonstrates the recurse handoff feature with per-item routing.
 */

import type { KladosJob, Output } from '@arke-institute/rhiza';
import type { SplitterTargetProps } from './types';

/** Minimum segment length - segments at or below this size are considered "done" */
const MIN_SEGMENT_LENGTH = 10;

/**
 * Process a job and return output with routing property
 *
 * @param job - The KladosJob instance
 * @returns Array of Output items with routing properties
 */
export async function processJob(job: KladosJob): Promise<Output[]> {
  const currentDepth = job.recurseDepth;

  job.log.info('Splitter starting', {
    depth: currentDepth,
    target: job.request.target_entity,
  });

  // Fetch the target entity
  const target = await job.fetchTarget<SplitterTargetProps>();

  // Initialize segments from text property or use existing segments
  let segments = target.properties.segments;
  if (!segments || segments.length === 0) {
    const text = target.properties.text ?? '';
    segments = text ? [text] : [];
  }

  job.log.info('Current state', {
    depth: currentDepth,
    segmentCount: segments.length,
    maxLength: segments.length > 0 ? Math.max(...segments.map((s) => s.length)) : 0,
  });

  // Check if all segments are at or below the threshold
  const allDone = segments.every((s) => s.length <= MIN_SEGMENT_LENGTH);

  if (allDone) {
    job.log.success('All segments below threshold - terminating', {
      depth: currentDepth,
      segmentCount: segments.length,
      segmentLengths: segments.map((s) => s.length),
    });

    // Return with done=true to route to "done" and terminate recursion
    return [{ entity_id: target.id, done: true }];
  }

  // Split segments that are too long
  const newSegments: string[] = [];
  let splitsMade = 0;

  for (const segment of segments) {
    if (segment.length > MIN_SEGMENT_LENGTH) {
      // Split in half
      const mid = Math.floor(segment.length / 2);
      newSegments.push(segment.slice(0, mid), segment.slice(mid));
      splitsMade++;
    } else {
      // Keep segment as-is
      newSegments.push(segment);
    }
  }

  // Update entity with new segments (CAS-safe)
  const { data: tip, error: tipError } = await job.client.api.GET('/entities/{id}/tip', {
    params: { path: { id: target.id } },
  });

  if (tipError || !tip) {
    throw new Error(`Failed to get entity tip: ${JSON.stringify(tipError)}`);
  }

  const splitCount = (target.properties.split_count ?? 0) + 1;

  const { error: updateError } = await job.client.api.PUT('/entities/{id}', {
    params: { path: { id: target.id } },
    body: {
      expect_tip: tip.cid,
      properties: {
        ...target.properties,
        segments: newSegments,
        split_count: splitCount,
        last_split_depth: currentDepth,
      },
    },
  });

  if (updateError) {
    throw new Error(`Failed to update entity: ${JSON.stringify(updateError)}`);
  }

  job.log.info('Split complete - continuing recursion', {
    depth: currentDepth,
    prevSegments: segments.length,
    newSegments: newSegments.length,
    splitsMade,
    splitCount,
  });

  // Return with done=false to route to recurse step
  return [{ entity_id: target.id, done: false }];
}
