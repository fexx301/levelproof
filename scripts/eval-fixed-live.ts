#!/usr/bin/env node
/**
 * Run the exact version-controlled 30-case semantic suite against the deployed
 * /api/compile path, then repeat one representative case per category twice.
 * This is separate from the deterministic fixtures and requires explicit
 * opt-in plus a software spend ceiling.
 */
import { writeFileSync } from 'node:fs';
import { compileResultSchema, type CompileResult } from '../shared/compile-result.js';
import { compileOkResponseSchema } from '../shared/api.js';
import {
  evaluateFixedCase,
  fixedEvaluationCases,
  type EvaluationCategory,
  type FixedEvaluationCase,
} from '../src/core/evaluation-suite.js';
import { revisionId } from '../src/core/serialize.js';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from './live-budget.js';

const DEFAULT_API = 'https://levelproof.vercel.app/api/compile';
const API = process.env.LEVELPROOF_API_URL ?? DEFAULT_API;
const REPORT_PATH = '/tmp/levelproof-live-evaluation.json';
const MIN_REQUEST_INTERVAL_MS = 7_700;
const REPRESENTATIVE_CASES = [
  'simple-add-key',
  'linked-remove-key-rule-door',
  'logic-surface-switch-trap',
  'preserve-protected-module',
  'ambiguity-the-door',
  'unsupported-jumping',
] as const;

interface LiveRecord {
  id: string;
  category: EvaluationCategory;
  run: number;
  prompt: string;
  responseType: string | null;
  resultSummary: Record<string, unknown> | null;
  cached: boolean | null;
  attempts: Array<{ model: string; outcome: string; latencyMs: number; costUsd: number | null }>;
  requestLatencyMs: number;
  costUsd: number | null;
  /** Strict model-output schema result, independent of server metadata. */
  schemaValid: boolean;
  responseContractValid: boolean;
  clientConsumable: boolean;
  responseBoundToBase: boolean | null;
  semanticFulfillment: boolean;
  protectionPreserved: boolean | null;
  unrelatedPreserved: boolean | null;
  gameplayVerified: boolean | null;
  previewApplicationConsistent: boolean | null;
  safeHandling: boolean;
  preProviderRejected: boolean;
  errors: string[];
  httpError: string | null;
}

function errorMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object' && 'error' in body) return String(body.error);
  return `HTTP ${status}`;
}

function reportedCost(body: unknown): number | null {
  if (body !== null && typeof body === 'object' && 'totalCostUsd' in body) {
    const cost = body.totalCostUsd;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) return cost;
  }
  if (body !== null && typeof body === 'object' && 'cached' in body && body.cached === true) return 0;
  return null;
}

function attemptsFrom(body: unknown): LiveRecord['attempts'] {
  if (body === null || typeof body !== 'object' || !('attempts' in body) || !Array.isArray(body.attempts)) return [];
  return body.attempts.map((item) => {
    if (item === null || typeof item !== 'object') {
      return { model: 'unknown', outcome: 'unknown', latencyMs: 0, costUsd: null };
    }
    const record = item as Record<string, unknown>;
    return {
      model: typeof record.model === 'string' ? record.model : 'unknown',
      outcome: typeof record.outcome === 'string' ? record.outcome : 'unknown',
      latencyMs: typeof record.latencyMs === 'number' ? record.latencyMs : 0,
      costUsd: typeof record.costUsd === 'number' ? record.costUsd : null,
    };
  });
}

function resultSummary(result: CompileResult): Record<string, unknown> {
  switch (result.type) {
    case 'patch': return { type: result.type, rationale: result.rationale, assumptions: result.assumptions, operations: result.operations };
    case 'rule_proposal': return { type: result.type, reason: result.reason, oldRequirements: result.oldRequirements, newRequirements: result.newRequirements, operations: result.operations };
    case 'clarification': return { type: result.type, question: result.question, choices: result.choices };
    case 'unsupported': return { type: result.type, reason: result.reason, alternatives: result.alternatives };
  }
}

const KNOWN_NO_PROVIDER_ERRORS = new Set([
  'request_protection_unavailable',
  'request_limit_reached',
  'request_too_large',
  'invalid_json',
  'invalid_request',
  'provider_not_configured',
]);

async function runOne(
  testCase: FixedEvaluationCase,
  run: number,
  budget: LiveBudget,
): Promise<LiveRecord> {
  const prompt = `${testCase.prompt}${'\n'.repeat(run - 1)}`;
  const label = `${testCase.id} run ${run}`;
  budget.ensureCanCall(label);
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: testCase.base,
        prompt,
        ...(testCase.protectedIds ? { protectedIds: testCase.protectedIds } : {}),
      }),
      signal: AbortSignal.timeout(58_000),
    });
  } catch (error) {
    throw new LiveEvaluationStop(`Stopping after ${label}: network/timeout failure; provider cost cannot be established (${error instanceof Error ? error.message : String(error)}).`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LiveEvaluationStop(`Stopping after ${label}: response body was unreadable, so spend cannot be established.`);
  }
  const cost = reportedCost(body);
  const attempts = attemptsFrom(body);
  // Request-guard rejections happen before any provider attempt. They cost no
  // model spend, but still end the run because later requests would be unsafe.
  const preProviderRejection = !response.ok && attempts.length === 0 && cost === null &&
    KNOWN_NO_PROVIDER_ERRORS.has(errorMessage(body, response.status));
  let budgetError: string | null = null;
  try {
    budget.record(preProviderRejection ? 0 : cost, label);
  } catch (error) {
    budgetError = error instanceof Error ? error.message : String(error);
  }

  const baseRecord: LiveRecord = {
    id: testCase.id,
    category: testCase.category,
    run,
    prompt,
    responseType: null,
    resultSummary: null,
    cached: body !== null && typeof body === 'object' && 'cached' in body && typeof body.cached === 'boolean'
      ? body.cached
      : null,
    attempts,
    requestLatencyMs: performance.now() - started,
    costUsd: cost ?? (preProviderRejection ? 0 : null),
    schemaValid: false,
    responseContractValid: false,
    clientConsumable: false,
    responseBoundToBase: null,
    semanticFulfillment: false,
    protectionPreserved: null,
    unrelatedPreserved: null,
    gameplayVerified: null,
    previewApplicationConsistent: null,
    safeHandling: preProviderRejection,
    preProviderRejected: preProviderRejection,
    errors: [],
    httpError: response.ok ? null : errorMessage(body, response.status),
  };

  if (budgetError !== null) baseRecord.errors.push(budgetError);

  if (!response.ok) {
    baseRecord.errors.push(baseRecord.httpError ?? `HTTP ${response.status}`);
    return baseRecord;
  }

  const responseEnvelope = compileOkResponseSchema.safeParse(body);
  const resultValue = body !== null && typeof body === 'object' && 'result' in body ? body.result : undefined;
  const resultParsed = compileResultSchema.safeParse(resultValue);
  if (!resultParsed.success) {
    baseRecord.errors.push(`model result failed schema validation: ${resultParsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
    if (!responseEnvelope.success) {
      baseRecord.errors.push(`response envelope failed validation: ${responseEnvelope.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
    }
    return baseRecord;
  }

  const result = resultParsed.data;
  const baseRevision = body !== null && typeof body === 'object' && 'baseRevision' in body && typeof body.baseRevision === 'string'
    ? body.baseRevision
    : null;
  const evaluated = evaluateFixedCase({ ...testCase, result });
  const responseBoundToBase = baseRevision !== null && baseRevision === revisionId(testCase.base);
  baseRecord.responseType = result.type;
  baseRecord.resultSummary = resultSummary(result);
  baseRecord.schemaValid = true;
  baseRecord.responseContractValid = responseEnvelope.success;
  baseRecord.clientConsumable = responseEnvelope.success && responseBoundToBase;
  baseRecord.responseBoundToBase = responseBoundToBase;
  baseRecord.semanticFulfillment = evaluated.semanticFulfillment;
  baseRecord.protectionPreserved = evaluated.protectionPreserved;
  baseRecord.unrelatedPreserved = evaluated.unrelatedPreserved;
  baseRecord.gameplayVerified = evaluated.gameplayVerified;
  baseRecord.previewApplicationConsistent = evaluated.previewApplicationConsistent;
  baseRecord.safeHandling = evaluated.safeHandling;
  baseRecord.errors.push(...evaluated.errors);
  if (baseRevision === null) baseRecord.errors.push('response baseRevision was missing');
  else if (!responseBoundToBase) baseRecord.errors.push('response baseRevision did not match the submitted level');
  if (!responseEnvelope.success) {
    baseRecord.errors.push(`response envelope failed validation: ${responseEnvelope.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  }
  return baseRecord;
}

function summarize(records: LiveRecord[]) {
  const categories = new Map<EvaluationCategory, LiveRecord[]>();
  for (const record of records) categories.set(record.category, [...(categories.get(record.category) ?? []), record]);
  return Object.fromEntries([...categories.entries()].map(([category, subset]) => [category, {
    total: subset.length,
    schemaValid: subset.filter((item) => item.schemaValid).length,
    responseContractValid: subset.filter((item) => item.responseContractValid).length,
    clientConsumable: subset.filter((item) => item.clientConsumable).length,
    semanticFulfillment: subset.filter((item) => item.semanticFulfillment).length,
    protectionPreserved: subset.filter((item) => item.protectionPreserved === true).length,
    protectionApplicable: subset.filter((item) => item.protectionPreserved !== null).length,
    unrelatedPreserved: subset.filter((item) => item.unrelatedPreserved === true).length,
    unrelatedApplicable: subset.filter((item) => item.unrelatedPreserved !== null).length,
    gameplayVerified: subset.filter((item) => item.gameplayVerified === true).length,
    gameplayApplicable: subset.filter((item) => item.gameplayVerified !== null).length,
    previewApplicationConsistent: subset.filter((item) => item.previewApplicationConsistent === true).length,
    previewApplicationApplicable: subset.filter((item) => item.previewApplicationConsistent !== null).length,
    safeHandling: subset.filter((item) => item.safeHandling).length,
    medianLatencyMs: median(subset.map((item) => item.requestLatencyMs)),
    failures: subset.filter((item) => !item.semanticFulfillment).map((item) => ({ id: item.id, run: item.run, errors: item.errors })),
  }]));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const budgetUsd = requireLiveBudget(
    args,
    'Usage: npm run eval:fixed:live -- --confirm-live-ai --budget-usd 1 [--prior-spend-usd 0.02522].',
  );
  const priorSpendIndex = args.indexOf('--prior-spend-usd');
  const rawPriorSpend = priorSpendIndex < 0 ? '0' : args[priorSpendIndex + 1];
  const priorKnownSpendUsd = rawPriorSpend === undefined ? Number.NaN : Number(rawPriorSpend);
  if (!Number.isFinite(priorKnownSpendUsd) || priorKnownSpendUsd < 0 || priorKnownSpendUsd >= budgetUsd) {
    throw new LiveEvaluationStop('Supply --prior-spend-usd between 0 and the overall software budget.');
  }
  const runBudgetUsd = budgetUsd - priorKnownSpendUsd;
  const budget = new LiveBudget(runBudgetUsd);
  const selectedCaseIndex = args.indexOf('--case');
  const selectedCaseId = selectedCaseIndex < 0 ? null : args[selectedCaseIndex + 1] ?? null;
  const byId = new Map(fixedEvaluationCases.map((testCase) => [testCase.id, testCase]));
  if (selectedCaseId !== null && !byId.has(selectedCaseId)) {
    throw new LiveEvaluationStop(`Unknown --case id: ${selectedCaseId}`);
  }
  for (const id of REPRESENTATIVE_CASES) {
    if (!byId.has(id)) throw new LiveEvaluationStop(`The live repeat case no longer exists: ${id}`);
  }
  const casesToRun = selectedCaseId === null ? fixedEvaluationCases : [byId.get(selectedCaseId)!];
  const expectedCount = selectedCaseId === null ? fixedEvaluationCases.length + REPRESENTATIVE_CASES.length * 2 : 1;
  const records: LiveRecord[] = [];
  let stopReason: string | null = null;
  let nextRequestAt = 0;

  try {
    const schedule: Array<{ testCase: FixedEvaluationCase; run: number }> = selectedCaseId === null
      ? [
          ...casesToRun.map((testCase) => ({ testCase, run: 1 })),
          ...REPRESENTATIVE_CASES.flatMap((id) => {
            const testCase = byId.get(id)!;
            return [{ testCase, run: 2 }, { testCase, run: 3 }];
          }),
        ]
      : casesToRun.map((testCase) => ({ testCase, run: 1 }));
    for (const { testCase, run } of schedule) {
      const waitMs = nextRequestAt - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const requestStarted = Date.now();
      const record = await runOne(testCase, run, budget);
      records.push(record);
      const marker = record.httpError !== null
        ? (record.preProviderRejected ? 'BLOCK' : 'ERR')
        : record.semanticFulfillment
          ? record.clientConsumable ? 'PASS' : 'PASS*'
          : 'FAIL';
      const costLabel = record.costUsd === null ? 'cost unknown' : `$${record.costUsd.toFixed(5)}`;
      const errorSummary = record.errors.length > 0 ? ` — ${record.errors.join('; ')}` : '';
      console.log(`${marker} ${String(records.length).padStart(2)} ${record.id} [${record.category}] run ${run} · ${record.responseType ?? '—'} · ${record.requestLatencyMs.toFixed(0)} ms · ${costLabel} · ${record.clientConsumable ? 'client-usable' : 'not client-usable'}${errorSummary}`);
      nextRequestAt = requestStarted + MIN_REQUEST_INTERVAL_MS;
      if (record.httpError !== null) {
        // Older strict request schemas may reject the new protectedIds field.
        // Record the incompatibility, make no provider call, and continue the
        // non-protected cases so we can still measure their live semantics.
        if (record.preProviderRejected && record.httpError === 'invalid_request' && (testCase.protectedIds?.length ?? 0) > 0) continue;
        throw new LiveEvaluationStop(`Stopping after ${record.id}: backend returned ${record.httpError}.`);
      }
      if (record.costUsd === null) {
        throw new LiveEvaluationStop(`Stopping after ${record.id}: cost was unknown; no further live calls were made.`);
      }
      if (budget.spentUsd > budgetUsd) {
        throw new LiveEvaluationStop(`Stopping after ${record.id}: measured spend $${budget.spentUsd.toFixed(5)} crossed the $${budgetUsd.toFixed(5)} software ceiling.`);
      }
    }
  } catch (error) {
    stopReason = error instanceof Error ? error.message : String(error);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    endpoint: API,
    source: 'live deployed backend; not fixture-based',
    baseCaseCount: fixedEvaluationCases.length,
    selectedCaseId,
    representativeCaseIds: REPRESENTATIVE_CASES,
    expectedRuns: expectedCount,
    completedRuns: records.length,
    complete: stopReason === null && records.length === expectedCount,
    stopReason,
    softwareBudgetUsd: budgetUsd,
    priorKnownSpendUsd,
    knownSpendThisRunUsd: budget.spentUsd,
    knownTotalSpendUsd: priorKnownSpendUsd + budget.spentUsd,
    providerSideHardCapVerified: false,
    byCategory: summarize(records),
    records,
  };
  const reportPath = selectedCaseId === null ? REPORT_PATH : `/tmp/levelproof-live-followup-${selectedCaseId}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nLive results: ${records.filter((record) => record.semanticFulfillment).length}/${records.length} semantic passes; known total spend $${(priorKnownSpendUsd + budget.spentUsd).toFixed(5)} / $${budgetUsd.toFixed(5)}.`);
  if (stopReason !== null) console.error(`Incomplete run: ${stopReason}`);
  console.log(`Report: ${reportPath}`);
  if (!report.complete) process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
