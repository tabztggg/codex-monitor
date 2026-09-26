import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficialUsageReader, parseOfficialUsage } from '../official-usage';
import { officialShares } from '../../../web/src/components/OfficialTaskUsagePanel';

const id = '00000000-0000-0000-0000-000000000001';
const payload = (weekly = 150) => ({ data_as_of: '2026-09-23T23:00:00Z', threads: [{ thread_id: id,
  data_status: 'available', weekly_limit_percent: weekly, balance_usage_credits: '0E-10', groups: [
    { model: 'gpt-6-astra', reasoning_effort: 'low', speed: 'standard', weekly_limit_percent: weekly * .6 },
    { model: 'gpt-6-astra', reasoning_effort: 'high', speed: 'standard', weekly_limit_percent: weekly * .3 },
    { model: 'gpt-6-luna', reasoning_effort: 'high', speed: 'standard', weekly_limit_percent: weekly * .1 }
  ] }] });
const directories: string[] = [];
async function setup() {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'monitor-official-test-'));
  directories.push(cacheDir);
  let now = Date.parse('2026-09-24T00:00:00Z');
  let account = 'a';
  const identity = async () => ({ key: account, accountId: account, token: 'private-test-token', email: `${account}@example.test` });
  const thread = vi.fn(async (threadId: string) => ({ thread_id: threadId, created_at: null, descendant_thread_ids: ['child'] }));
  const transport = vi.fn<typeof fetch>(async () => Response.json(payload()));
  const options = { cacheDir, identity, thread, fetch: transport, now: () => now };
  return { reader: new OfficialUsageReader(options), options, transport, thread, cacheDir,
    advance: () => { now += 300_001; }, switch: () => { account = 'b'; } };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))); });

describe('official task lifetime usage', () => {
  it('preserves percentages over 100 and credits zero, aggregating composition without estimating prices', () => {
    const data = parseOfficialUsage(payload(), id, '2026-09-24T00:00:00Z');
    expect(data.weeklyPercent).toBe(150);
    expect(data.credits).toBe(0);
    expect(officialShares(data, 'model')).toEqual([{ name: 'gpt-6-astra', share: 90 }, { name: 'gpt-6-luna', share: 10 }]);
    expect(officialShares(data, 'effort')).toEqual([{ name: 'low', share: 60 }, { name: 'high', share: 40 }]);
    expect(officialShares(data, 'speed')).toEqual([{ name: 'standard', share: 100 }]);
    const zero = parseOfficialUsage(payload(0), id, '2026-09-24T00:00:00Z');
    expect(officialShares(zero, 'model').every(item => item.share === null)).toBe(true);
    expect(() => parseOfficialUsage({ threads: [] }, id, '')).toThrow();
  });

  it('coalesces reads, reuses disk cache after restart, and never persists credentials', async () => {
    const s = await setup();
    const results = await Promise.all([s.reader.read(id), s.reader.read(id), s.reader.read(id)]);
    expect(s.transport).toHaveBeenCalledTimes(1);
    expect(results.every(result => result.data?.weeklyPercent === 150)).toBe(true);
    const init = s.transport.mock.calls[0][1]!;
    expect(JSON.parse(String(init.body)).threads[0].descendant_thread_ids).toEqual(['child']);
    expect(init.redirect).toBe('error');
    expect((await new OfficialUsageReader(s.options).read(id)).data?.weeklyPercent).toBe(150);
    expect(s.transport).toHaveBeenCalledTimes(1);
    const cache = await readFile(path.join(s.cacheDir, (await readdir(s.cacheDir))[0]), 'utf8');
    expect(cache).not.toContain('private-test-token');
    expect(cache).not.toContain('example.test');
  });

  it('serves stale values immediately and backs off after provider failure', async () => {
    const s = await setup();
    await s.reader.read(id);
    s.advance();
    let finish!: (response: Response) => void;
    s.transport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const stale = await s.reader.read(id);
    expect(stale.data?.weeklyPercent).toBe(150);
    expect(stale.stale).toBe(true);
    expect(stale.refreshing).toBe(true);
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish(new Response('private failure detail', { status: 429 }));
    await vi.waitFor(async () => expect((await s.reader.read(id)).refreshing).toBe(false));
    expect((await s.reader.read(id)).data?.weeklyPercent).toBe(150);
    expect(s.transport).toHaveBeenCalledTimes(2);
  });

  it('does not mix accounts, including a login switch during a response', async () => {
    const s = await setup();
    await s.reader.read(id);
    s.switch();
    s.transport.mockResolvedValueOnce(new Response('', { status: 401 }));
    expect((await s.reader.read(id)).data).toBeNull();
    const race = await setup();
    race.transport.mockImplementationOnce(async () => { race.switch(); return Response.json(payload()); });
    expect((await race.reader.read(id)).data).toBeNull();
    expect(await readdir(race.cacheDir)).toEqual([]);
  });

  it('replaces stale data only after a successful background response', async () => {
    const s = await setup();
    await s.reader.read(id);
    s.advance();
    s.transport.mockResolvedValueOnce(Response.json(payload(160)));
    expect((await s.reader.read(id)).data?.weeklyPercent).toBe(150);
    await vi.waitFor(async () => expect((await s.reader.read(id)).data?.weeklyPercent).toBe(160));
    await vi.waitFor(async () => expect((await s.reader.read(id)).refreshing).toBe(false));
    expect((await s.reader.read(id)).stale).toBe(false);
  });

  it('bounds provider calls across many expanded tasks and clients', async () => {
    const s = await setup();
    s.transport.mockImplementation(async (_url, init) => {
      const requestedId = JSON.parse(String(init?.body)).threads[0].thread_id;
      const data = payload();
      data.threads[0].thread_id = requestedId;
      return Response.json(data);
    });
    for (let i = 1; i <= 20; i++) await s.reader.read(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    expect(s.transport).toHaveBeenCalledTimes(10);
  });

  it('rejects arbitrary paths and unknown local threads without making requests', async () => {
    const s = await setup();
    expect((await s.reader.read('../auth.json')).data).toBeNull();
    s.options.thread.mockResolvedValueOnce(null as never);
    expect((await s.reader.read(id)).data).toBeNull();
    expect(s.transport).not.toHaveBeenCalled();
  });
});
