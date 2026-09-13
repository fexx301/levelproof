import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { encodeLevelShare } from '../src/core/serialize';
import { decodeAcceptedShare, isAcceptedCheckpoint } from '../src/state/store';

describe('shared-link acceptance boundary', () => {
  it('only opens a schema-valid, accepted checkpoint from a share payload', () => {
    const acceptedPayload = encodeLevelShare(baselineLevel);
    expect(decodeAcceptedShare(acceptedPayload)).not.toBeNull();
    expect(isAcceptedCheckpoint(decodeAcceptedShare(acceptedPayload))).toBe(true);

    const failing = structuredClone(baselineLevel);
    failing.goal = 'gallery';
    const failingPayload = encodeLevelShare(failing);
    expect(decodeAcceptedShare(failingPayload)).toBeNull();
    expect(decodeAcceptedShare(`${acceptedPayload.slice(0, -2)}zz`)).toBeNull();
  });
});
