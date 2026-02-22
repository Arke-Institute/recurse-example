#!/usr/bin/env npx tsx
/**
 * Unified Registration Script for Recurse Test
 *
 * Supports both klados and workflow registration:
 *   ARKE_USER_KEY=uk_... npx tsx scripts/register.ts                  # Register klados
 *   ARKE_USER_KEY=uk_... npx tsx scripts/register.ts --workflow X     # Register workflow
 *   ARKE_USER_KEY=uk_... npx tsx scripts/register.ts --production     # Main network
 *   ARKE_USER_KEY=uk_... npx tsx scripts/register.ts --dry-run        # Preview only
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import { ArkeClient } from '@arke-institute/sdk';
import {
  syncKlados,
  syncRhiza,
  readState,
  writeState,
  getStateFilePath,
  findWorkspaceConfig,
  resolveWorkspaceCollection,
  type KladosConfig,
  type KladosRegistrationState,
  type RhizaConfig,
  type RhizaRegistrationState,
  type DryRunResult,
  type SyncResult,
} from '@arke-institute/rhiza/registration';

// =============================================================================
// CloudflareKeyStore - inline to avoid relative import issues
// =============================================================================

class CloudflareKeyStore {
  private cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  async get(_name: string): Promise<string | null> {
    return null;
  }

  async set(name: string, value: string): Promise<void> {
    execSync(`echo "${value}" | wrangler secret put ${name}`, {
      cwd: this.cwd,
      stdio: 'pipe',
    });
  }

  async delete(name: string): Promise<void> {
    try {
      execSync(`wrangler secret delete ${name} --force`, {
        cwd: this.cwd,
        stdio: 'pipe',
      });
    } catch {
      // Ignore if secret doesn't exist
    }
  }

  async exists(_name: string): Promise<boolean> {
    return false;
  }
}

// =============================================================================
// Configuration
// =============================================================================

const ARKE_USER_KEY = process.env.ARKE_USER_KEY;

// =============================================================================
// Helper Functions
// =============================================================================

async function waitForDeployment(endpoint: string, maxWaitMs = 30000): Promise<void> {
  const startTime = Date.now();
  const checkInterval = 2000;

  console.log(`  Waiting for ${endpoint}/health...`);

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`${endpoint}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (res.ok) {
        console.log('  Worker is responding');
        return;
      }
    } catch {
      // Ignore errors, keep trying
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  console.warn('  Health check timed out, attempting verification anyway...');
}

function updateWranglerConfig(kladosId: string): boolean {
  try {
    const wranglerPath = 'wrangler.jsonc';
    if (!existsSync(wranglerPath)) return false;

    let content = readFileSync(wranglerPath, 'utf-8');
    content = content.replace(/"AGENT_ID":\s*"[^"]*"/, `"AGENT_ID": "${kladosId}"`);
    writeFileSync(wranglerPath, content);
    return true;
  } catch {
    return false;
  }
}

function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    if (obj.startsWith('$')) {
      const envVar = obj.slice(1);
      const value = process.env[envVar];
      if (!value) {
        throw new Error(`Environment variable ${envVar} is not set`);
      }
      return value;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars);
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey =
        typeof key === 'string' && key.startsWith('$')
          ? (process.env[key.slice(1)] ?? key)
          : key;
      result[newKey] = substituteEnvVars(value);
    }
    return result;
  }

  return obj;
}

function isDryRunResult(
  result: SyncResult<KladosRegistrationState> | SyncResult<RhizaRegistrationState> | DryRunResult
): result is DryRunResult {
  return (
    result.action === 'would_create' ||
    result.action === 'would_update' ||
    (result.action === 'unchanged' && !('state' in result))
  );
}

// =============================================================================
// Klados Registration
// =============================================================================

async function registerKlados(
  client: ArkeClient,
  network: 'test' | 'main',
  isDryRun: boolean
): Promise<void> {
  console.log(`\n📦 Klados Registration (${network} network)${isDryRun ? ' [DRY RUN]' : ''}\n`);

  if (!existsSync('agent.json')) {
    console.error('Error: agent.json not found');
    process.exit(1);
  }

  const config: KladosConfig = JSON.parse(readFileSync('agent.json', 'utf-8'));
  console.log(`Agent: ${config.label}`);
  console.log(`Endpoint: ${config.endpoint}`);
  console.log('');

  const stateFile = getStateFilePath('.klados-state', network);
  const state = readState<KladosRegistrationState>(stateFile);

  if (state) {
    console.log(`Found existing klados: ${state.klados_id}`);
  } else {
    console.log('Creating new klados...\n');
  }

  const keyStore = new CloudflareKeyStore(process.cwd());

  // Check for workspace config (shared collection across kladoi)
  const workspace = findWorkspaceConfig();
  let collectionId: string | undefined;

  if (workspace) {
    console.log(`Found workspace config: ${workspace.path}`);
    if (!isDryRun) {
      const resolved = await resolveWorkspaceCollection(client, network, workspace.path);
      collectionId = resolved.collectionId;
      if (!resolved.created) {
        console.log(`Using workspace collection: ${collectionId}`);
      }
    } else {
      const networkConfig = workspace.config[network];
      if (networkConfig.collection_id) {
        collectionId = networkConfig.collection_id;
        console.log(`Would use workspace collection: ${collectionId}`);
      } else {
        console.log(`Would create workspace collection: ${networkConfig.collection_label}`);
      }
    }
    console.log('');
  }

  const result = await syncKlados(client, config, state, {
    network,
    collectionId,
    keyStore,
    dryRun: isDryRun,
    onDeploy: async () => {
      console.log('\n🚀 Deploying worker...');
      execSync('wrangler deploy', { stdio: 'inherit' });
    },
    onWaitForHealth: async (endpoint) => {
      console.log('\n⏳ Waiting for deployment...');
      await waitForDeployment(endpoint);
    },
  });

  if (isDryRunResult(result)) {
    console.log(`\n📋 Would: ${result.action}`);
    if (result.changes && result.changes.length > 0) {
      console.log('\nChanges:');
      for (const change of result.changes) {
        console.log(`  ${change.field}: ${change.from ?? '(none)'} → ${change.to}`);
      }
    }
    console.log('\nRun without --dry-run to apply changes.');
    return;
  }

  const { action, state: newState } = result;

  if (action === 'created') {
    console.log('\n📝 Updating wrangler.jsonc...');
    if (updateWranglerConfig(newState.klados_id)) {
      console.log(`  AGENT_ID set to ${newState.klados_id}`);
    } else {
      console.warn('  Could not update wrangler.jsonc');
      console.warn(`  Set AGENT_ID manually: "${newState.klados_id}"`);
    }

    console.log('\n🚀 Final deployment...');
    execSync('wrangler deploy', { stdio: 'inherit' });
  }

  if (action !== 'unchanged') {
    writeState(stateFile, newState);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Klados ${action}!`);
  console.log(`${'='.repeat(60)}`);
  console.log(`   ID: ${newState.klados_id}`);
  console.log(`   Collection: ${newState.collection_id}`);
  console.log(`   Endpoint: ${newState.endpoint}`);
  if (newState.api_key_prefix) {
    console.log(`   API Key: ${newState.api_key_prefix}...`);
  }
  console.log(`${'='.repeat(60)}\n`);

  // Set environment variable for workflow registration
  process.env.SPLITTER_KLADOS = newState.klados_id;
}

// =============================================================================
// Workflow Registration
// =============================================================================

async function registerWorkflow(
  client: ArkeClient,
  workflowName: string,
  network: 'test' | 'main',
  isDryRun: boolean
): Promise<void> {
  console.log(`\n📦 Rhiza Registration (${network} network)${isDryRun ? ' [DRY RUN]' : ''}\n`);
  console.log(`Workflow: ${workflowName}`);

  const workflowFile = path.join('workflows', `${workflowName}.json`);

  if (!existsSync(workflowFile)) {
    console.error(`Error: Workflow file not found: ${workflowFile}`);
    process.exit(1);
  }

  const rawContent = readFileSync(workflowFile, 'utf-8');
  const rawWorkflow = JSON.parse(rawContent);

  let config: RhizaConfig;
  try {
    config = substituteEnvVars(rawWorkflow) as RhizaConfig;
  } catch (error) {
    console.error(`\nError: ${(error as Error).message}`);
    console.error('Make sure SPLITTER_KLADOS is set (run klados registration first).');
    process.exit(1);
  }

  console.log(`Label: ${config.label}`);
  console.log(`Version: ${config.version}`);
  console.log(`Entry: ${config.entry}`);
  console.log(`Steps: ${Object.keys(config.flow).length}`);
  for (const [stepName, step] of Object.entries(config.flow)) {
    // Access as 'pi' or 'id' depending on JSON format
    const kladosRef = step.klados as { pi?: string; id?: string };
    console.log(`  - ${stepName}: ${kladosRef.pi ?? kladosRef.id}`);
  }
  console.log('');

  const stateFile = getStateFilePath(`.rhiza-state-${workflowName}`, network);
  const state = readState<RhizaRegistrationState>(stateFile);

  if (state) {
    console.log(`Found existing rhiza: ${state.rhiza_id}`);
  } else {
    console.log('Creating new rhiza...\n');
  }

  const result = await syncRhiza(client, config, state, {
    network,
    dryRun: isDryRun,
    collectionLabel: `Rhiza: ${config.label}`,
  });

  if (isDryRunResult(result)) {
    console.log(`\n📋 Would: ${result.action}`);
    if (result.changes && result.changes.length > 0) {
      console.log('\nChanges:');
      for (const change of result.changes) {
        console.log(`  ${change.field}: ${change.from ?? '(none)'} → ${change.to}`);
      }
    }
    console.log('\nRun without --dry-run to apply changes.');
    return;
  }

  const { action, state: newState } = result;

  if (action !== 'unchanged') {
    writeState(stateFile, newState);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Rhiza ${action}!`);
  console.log(`${'='.repeat(60)}`);
  console.log(`   ID: ${newState.rhiza_id}`);
  console.log(`   Collection: ${newState.collection_id}`);
  console.log(`   Version: ${newState.version}`);
  console.log(`${'='.repeat(60)}\n`);

  console.log(`To run tests: RHIZA_ID=${newState.rhiza_id} npm test`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  if (!ARKE_USER_KEY) {
    console.error('Error: ARKE_USER_KEY environment variable is required');
    process.exit(1);
  }

  const isProduction =
    process.argv.includes('--production') || process.argv.includes('--prod');
  const isDryRun = process.argv.includes('--dry-run');
  const network = isProduction ? 'main' : 'test';

  // Check for --workflow flag
  const workflowIndex = process.argv.indexOf('--workflow');
  const workflowName = workflowIndex !== -1 ? process.argv[workflowIndex + 1] : null;

  const client = new ArkeClient({ authToken: ARKE_USER_KEY, network });

  try {
    if (workflowName) {
      // Register workflow only
      await registerWorkflow(client, workflowName.replace(/\.json$/, ''), network, isDryRun);
    } else {
      // Register klados
      await registerKlados(client, network, isDryRun);
    }
  } catch (error) {
    console.error('\n❌ Registration failed:');
    console.error(`   ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main();
