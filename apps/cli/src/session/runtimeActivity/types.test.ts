import { describe, expect, it } from 'vitest';
import { SessionRuntimeActivitySnapshotSchema } from '@happier-dev/protocol';

import { SessionRuntimeActivityContributionSchema } from './types';

describe('runtime activity contribution schema', () => {
  it('retains the exact public snapshot schema runtime value', () => {
    expect(SessionRuntimeActivityContributionSchema).toBe(SessionRuntimeActivitySnapshotSchema);
  });
});
