# Recurse Test - Text Splitter

Example klados worker and rhiza workflow demonstrating the `recurse` handoff pattern.

## Overview

This example shows bounded recursion in Arke workflows. The worker recursively splits text segments until they're below a threshold length, using `recurse` handoff with `max_depth` for safety limits.

**Algorithm:**
1. Receive entity with `text` property (or existing `segments` array)
2. Split any segment longer than 10 characters in half
3. Update entity with new segments array
4. Return `{ entity_id, done: true }` if all segments are small enough
5. Return `{ entity_id, done: false }` to trigger another iteration

## Workflow Definition

```json
{
  "entry": "split",
  "flow": {
    "split": {
      "klados": { "id": "$SPLITTER_KLADOS" },
      "then": {
        "recurse": "split",
        "max_depth": 10,
        "route": [
          { "where": { "property": "done", "equals": true }, "target": "done" }
        ]
      }
    }
  }
}
```

## Commands

```bash
npm install              # Install dependencies
npm run dev              # Local development with wrangler
npm run deploy           # Deploy to Cloudflare Workers
npm run type-check       # TypeScript validation

# Registration (requires ARKE_USER_KEY)
npm run register                              # Register klados to test network
SPLITTER_KLADOS=xxx npm run register -- --workflow recurse-test  # Register workflow

# Testing
KLADOS_ID=xxx npm test   # Run E2E tests
```

## Test Results

For 80-character input:
- 4 iterations total (3 splits + 1 completion check)
- Final result: 8 segments of 10 characters each

For 320-character input:
- 6 iterations total (5 splits + 1 completion check)
- Final result: 32 segments of 10 characters each

## Key Files

- `src/job.ts` - Core splitting logic with CAS-safe updates
- `workflows/recurse-test.json` - Workflow definition with `recurse` handoff
- `test/recurse.test.ts` - E2E tests demonstrating recursive behavior
- `scripts/register.ts` - Registration script for klados and workflow

## Dependencies

- `@arke-institute/rhiza` - Workflow protocol library
- `@arke-institute/sdk` - Arke API client
- `hono` - Web framework for Cloudflare Workers
