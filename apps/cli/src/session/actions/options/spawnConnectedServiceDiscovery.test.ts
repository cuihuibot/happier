import type { AccountProfileResponse } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { listSpawnConnectedServiceItems } from './spawnConnectedServiceDiscovery';

// The discovery owner only reads `connectedServicesV2` off the account profile; the rest of the
// response is an untouched server payload, so the fixture narrows to the consumed projection.
function createAccountProfile(
  connectedServicesV2: AccountProfileResponse['connectedServicesV2'],
): AccountProfileResponse {
  return { connectedServicesV2 } as unknown as AccountProfileResponse;
}

describe('listSpawnConnectedServiceItems', () => {
  it('offers the GitHub token profile to Copilot spawns', () => {
    const result = listSpawnConnectedServiceItems({
      accountSettings: {},
      accountProfile: createAccountProfile([
        {
          serviceId: 'github',
          profiles: [{ profileId: 'default', status: 'connected', kind: 'token' }],
        },
      ] as unknown as AccountProfileResponse['connectedServicesV2']),
      agentId: 'copilot',
      connectedServicesFeatureEnabled: true,
      accountGroupsFeatureEnabled: false,
    });

    expect(result.items.map((item) => item.serviceId)).toEqual(['github']);
    expect(result.items[0]?.profiles).toEqual([
      expect.objectContaining({ profileId: 'default', status: 'connected', kind: 'token' }),
    ]);
    expect(result.items[0]?.defaultProfileId).toBe('default');
  });

  it('does not offer GitHub to an agent that cannot consume it', () => {
    const result = listSpawnConnectedServiceItems({
      accountSettings: {},
      accountProfile: createAccountProfile([
        {
          serviceId: 'github',
          profiles: [{ profileId: 'default', status: 'connected', kind: 'token' }],
        },
      ] as unknown as AccountProfileResponse['connectedServicesV2']),
      agentId: 'claude',
      connectedServicesFeatureEnabled: true,
      accountGroupsFeatureEnabled: false,
    });

    expect(result.items.map((item) => item.serviceId)).toEqual([]);
  });
});
