import { useEffect, useMemo, useRef, useState } from 'react';
import type { Level } from '../shared/schema';
import { baselineLevel } from './core/fixtures/baseline';
import { trapLevel } from './core/fixtures/trap';
import { compileLevel } from './core/topology';
import { verify, type CheckedResult, type Report } from './core/verifier';
import { mountScene } from './render/scene';

const FIXTURES = { baseline: baselineLevel, trap: trapLevel } as const;
type FixtureName = keyof typeof FIXTURES;

const FIXTURE_LABELS: Record<FixtureName, string> = {
  baseline: 'Balcony Vault (baseline)',
  trap: 'Switch trap',
};

/**
 * Minimal deployed scene (§14 Sep 11–12 gate): the diorama rendered from the
 * compiled core, the three-check strip with surfaced measurements, and a
 * fixture toggle. The full §12 shell lands with the designed UI milestone.
 */
export function App() {
  const [fixture, setFixture] = useState<FixtureName>('baseline');
  const level = FIXTURES[fixture];
  const { report, ms } = useMemo(() => {
    const t0 = performance.now();
    const result = verify(level);
    return { report: result, ms: performance.now() - t0 };
  }, [level]);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">LevelProof</h1>
        <p className="app-sub">An AI puzzle creator with automatic playtesting</p>
        <div className="fixture-toggle" role="tablist" aria-label="Fixture">
          {(Object.keys(FIXTURES) as FixtureName[]).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === fixture}
              className={`fixture-toggle-button${name === fixture ? ' is-active' : ''}`}
              onClick={() => setFixture(name)}
            >
              {FIXTURE_LABELS[name]}
            </button>
          ))}
        </div>
      </header>
      <main className="app-main">
        <Viewport level={level} />
        <CheckStrip report={report} ms={ms} />
      </main>
    </div>
  );
}

function Viewport({ level }: { level: Level }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = mountScene(host, compileLevel(level));
    return () => handle.dispose();
  }, [level]);
  return <div className="viewport" ref={hostRef} aria-label="3D scene" />;
}

function statusText(status: CheckedResult['status']): string {
  switch (status) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'fail';
    case 'unknown':
      return 'check incomplete';
    case 'not_applicable':
      return 'not applicable';
  }
}

function CheckStrip({ report, ms }: { report: Report; ms: number }) {
  const checks: Array<{ name: string; result: CheckedResult }> = [
    { name: 'Solution', result: report.checks.solution },
    { name: 'Design requirements', result: report.checks.requirements },
    { name: 'Recovery', result: report.checks.recovery },
  ];
  return (
    <aside className="check-strip" aria-label="Verification checks">
      <p className={`acceptance${report.accepted ? ' is-accepted' : ''}`}>
        {report.accepted ? 'Accepted' : 'Not accepted'}
      </p>
      {checks.map(({ name, result }) => (
        <section key={name} className={`check check--${result.status}`}>
          <h2 className="check-name">
            <span>{name}</span>
            <span className="check-status">{statusText(result.status)}</span>
          </h2>
          <p className="check-explanation">{result.explanation}</p>
        </section>
      ))}
      <p className="check-meta">
        {report.revisionId} · catalog {report.catalogVersion} · verifier {report.verifierVersion} ·{' '}
        {report.exploredCount} states explored · {ms.toFixed(1)} ms
      </p>
      <p className="check-note">
        Under these game rules. Exhaustive bounded exploration — one successful route never
        proves no bypasses or dead ends.
      </p>
    </aside>
  );
}
