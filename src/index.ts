/**
 * Recurse Splitter Worker
 *
 * A klados worker that recursively splits text into smaller segments.
 * Used to test the recurse handoff feature in rhiza workflows.
 *
 * Algorithm:
 * 1. Receive entity with text or segments
 * 2. Split any segment longer than MIN_SEGMENT_LENGTH in half
 * 3. Update entity with new segments
 * 4. Return done=true if all segments are small enough, else done=false
 * 5. Workflow routes: done=true -> terminate, done=false -> recurse
 */

import { Hono } from 'hono';
import { KladosJob, type KladosRequest } from '@arke-institute/rhiza';
import { processJob } from './job';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

/**
 * Health check endpoint
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    agent_id: c.env.AGENT_ID,
    version: c.env.AGENT_VERSION,
  });
});

/**
 * Arke verification endpoint
 * Required to verify ownership of this endpoint before activating the klados.
 */
app.get('/.well-known/arke-verification', (c) => {
  const token = c.env.VERIFICATION_TOKEN;
  const kladosId = c.env.ARKE_VERIFY_AGENT_ID || c.env.AGENT_ID;

  if (!token || !kladosId) {
    return c.json({ error: 'Verification not configured' }, 500);
  }

  return c.json({
    verification_token: token,
    klados_id: kladosId,
  });
});

/**
 * Main job processing endpoint
 */
app.post('/process', async (c) => {
  const req = await c.req.json<KladosRequest>();

  // Accept the job immediately
  const job = KladosJob.accept(req, {
    agentId: c.env.AGENT_ID,
    agentVersion: c.env.AGENT_VERSION,
    authToken: c.env.ARKE_AGENT_KEY,
  });

  // Process in background
  c.executionCtx.waitUntil(
    job.run(async () => {
      return await processJob(job);
    })
  );

  // Return acceptance immediately
  return c.json(job.acceptResponse);
});

export default app;
