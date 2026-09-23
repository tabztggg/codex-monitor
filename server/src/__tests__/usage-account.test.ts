import { describe, expect, it } from 'vitest';
import { readAccountUsage, usageAccount } from '../usage';

const account = (email: string) => ({ account: { type: 'chatgpt', email, planType: 'pro', accessToken: 'must-not-leak' } });
const limits = { rateLimits: { limitId: 'codex', secondary: { usedPercent: 24, windowDurationMins: 10080 } } };
describe('usage account attribution', () => {
  it('only exposes allowlisted display fields', () => {
    expect(usageAccount(account('sample@example.com'))).toEqual({ type: 'chatgpt', email: 'sample@example.com', planType: 'pro' });
    expect(usageAccount({ account: null })).toBeNull();
    expect(usageAccount({ account: { type: 'apiKey', apiKey: 'secret' } })).toEqual({ type: 'apiKey', email: null, planType: null });
  });
  it('pairs account and limits using the same client without refreshing credentials', async () => {
    const calls: string[] = [];
    const result = await readAccountUsage({ request: async (method, params) => {
      calls.push(method);
      if (method === 'account/read') { expect(params).toEqual({ refreshToken: false }); return account('sample@example.com'); }
      return limits;
    } });
    expect(calls).toEqual(['account/read', 'account/rateLimits/read', 'account/read']);
    expect(result.account?.email).toBe('sample@example.com');
    expect(result.primaryLimit?.secondary?.usedPercent).toBe(24);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });
  it('does not label old limits with a newly switched account', async () => {
    let reads = 0;
    const result = await readAccountUsage({ request: async method => method === 'account/read' ? account(++reads === 1 ? 'old@example.com' : 'new@example.com') : limits });
    expect(result.status).toBe('unavailable');
    expect(result.limits).toEqual([]);
    expect(result.account).toBeUndefined();
  });
  it('keeps unknown identity explicit when account read is unsupported', async () => {
    const result = await readAccountUsage({ request: async method => {
      if (method === 'account/read') throw new Error('unsupported');
      return limits;
    } });
    expect(result.status).toBe('available');
    expect(result.account).toBeNull();
  });
  it('never carries an old account quota into a failed new-account read or a confirmed logout', async () => {
    const previous = await readAccountUsage({ request: async method => method === 'account/read' ? account('old@example.com') : limits });
    for (const identity of [account('new@example.com'), { account: null }]) {
      const next = await readAccountUsage({ request: async method => {
        if (method === 'account/read') return identity;
        throw new Error('quota offline');
      } }, previous);
      expect(next.limits).toEqual([]);
      expect(next.stale).not.toBe(true);
    }
  });
  it('retains the old identity and success timestamp explicitly when all reads are temporarily unavailable', async () => {
    const previous = await readAccountUsage({ request: async method => method === 'account/read' ? account('old@example.com') : limits });
    const next = await readAccountUsage({ request: async () => { throw new Error('offline'); } }, previous);
    expect(next).toMatchObject({ stale: true, account: previous.account, updatedAt: previous.updatedAt, limits: previous.limits });
  });
});
