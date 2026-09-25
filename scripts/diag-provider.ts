#!/usr/bin/env node
/**
 * Provider compatibility diagnostic: isolates which request feature a model
 * rejects (strict json_schema, unified reasoning effort, or neither) and
 * prints the FULL provider error, untruncated. Usage:
 *   npx tsx scripts/diag-provider.ts <model> --confirm-live-ai --budget-usd 0.10
 */
import { chatCompletion, providerConfigFromEnv } from '../api/_lib/provider';
import { compileResultJsonSchema } from '../api/_lib/wire-schema';
import { buildSystemPrompt } from '../api/_lib/prompt';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { revisionId } from '../src/core/serialize';
import { readFileSync } from 'node:fs';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from './live-budget';

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

try {
  const args = process.argv.slice(2);
  const limit = requireLiveBudget(
    args,
    'Usage: npx tsx scripts/diag-provider.ts <model> --confirm-live-ai --budget-usd 0.10',
  );
  const model = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--budget-usd');
  if (!model) throw new LiveEvaluationStop('Supply the model id before the live-evaluation flags.');

  loadDotEnv();
  const base = providerConfigFromEnv(process.env, model);
  if (!base) throw new LiveEvaluationStop('Missing provider configuration.');
  const budget = new LiveBudget(limit);

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
    budget.ensureCanCall(variant.name);
    const result = await chatCompletion({ ...base, timeoutMs: 90000 }, messages, { ...variant.options, maxTokens: 1000 });
    if (result.ok) {
      budget.record(result.usage.costUsd, variant.name);
      console.log(`[${variant.name}] OK (${result.usage.promptTokens}+${result.usage.completionTokens} tokens, $${result.usage.costUsd!.toFixed(5)} provider-reported) content starts: ${result.content.slice(0, 120)}`);
    } else {
      budget.record(null, variant.name);
    }
  }
  console.log(`Known provider-reported spend: $${budget.spentUsd.toFixed(5)} / $${limit.toFixed(5)}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
