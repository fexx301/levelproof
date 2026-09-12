#!/usr/bin/env node
/**
 * Provider compatibility diagnostic: isolates which request feature a model
 * rejects (strict json_schema, unified reasoning effort, or neither) and
 * prints the FULL provider error, untruncated. Usage:
 *   npx tsx scripts/diag-provider.ts <model>
 */
import { chatCompletion, providerConfigFromEnv } from '../api/_lib/provider';
import { compileResultJsonSchema } from '../api/_lib/wire-schema';
import { buildSystemPrompt } from '../api/_lib/prompt';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { revisionId } from '../src/core/serialize';
import { readFileSync } from 'node:fs';

function loadDotEnv(): void {
  try {
    const raw = readFileSync('.env', 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env — rely on the real environment.
  }
}

const model = process.argv[2];
if (!model) {
  console.error('Usage: npx tsx scripts/diag-provider.ts <model>');
  process.exit(1);
}

loadDotEnv();
const base = providerConfigFromEnv(process.env, model);
if (!base) {
  console.error('Missing provider configuration.');
  process.exit(1);
}

const messages = [
  { role: 'system' as const, content: buildSystemPrompt(vaultEmptyLevel, revisionId(vaultEmptyLevel)) },
  { role: 'user' as const, content: 'Put a brass key on the side balcony.' },
];

const variants = [
  { name: 'schema+reasoning', options: { jsonSchema: compileResultJsonSchema as unknown as Record<string, unknown>, schemaName: 'levelproof_result', reasoningEffort: 'low' as const } },
  { name: 'schema only', options: { jsonSchema: compileResultJsonSchema as unknown as Record<string, unknown>, schemaName: 'levelproof_result' } },
  { name: 'reasoning only', options: { reasoningEffort: 'low' as const } },
  { name: 'plain', options: {} },
];

for (const variant of variants) {
  const result = await chatCompletion({ ...base, timeoutMs: 90000 }, messages, variant.options);
  if (result.ok) {
    console.log(`[${variant.name}] OK (${result.usage.promptTokens}+${result.usage.completionTokens} tokens, $${(result.usage.costUsd ?? 0).toFixed(5)}) content starts: ${result.content.slice(0, 120)}`);
  } else {
    console.log(`[${variant.name}] ${result.kind}: ${result.error}`);
  }
}
