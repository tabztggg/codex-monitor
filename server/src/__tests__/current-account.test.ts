import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FreshCurrentAccountSource, readAuthIdentityFingerprint } from '../current-account';
import { emptyCodexUsage, readAccountUsage } from '../usage';

const claims = (email: string) => `header.${Buffer.from(JSON.stringify({ email, sub: email })).toString('base64url')}.signature`;
const auth = (email: string, access = 'secret') => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: email, id_token: claims(email), access_token: access, refresh_token: 'never-save' } });
let home: string;
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), 'monitor-identity-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

it('detects a different account even when a switcher preserves size and mtime', async () => {
  const file = path.join(home, 'auth.json');
  writeFileSync(file, auth('a@example.com')); utimesSync(file, 1000, 1000);
  const first = await readAuthIdentityFingerprint(home);
  writeFileSync(file, auth('b@example.com')); utimesSync(file, 1000, 1000);
  expect(await readAuthIdentityFingerprint(home)).not.toBe(first);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
});

it('ignores token rotation without a change of account and tolerates missing/partial auth files', async () => {
  expect(await readAuthIdentityFingerprint(home)).toBe('missing');
  const file = path.join(home, 'auth.json'); writeFileSync(file, auth('a@example.com'));
  const first = await readAuthIdentityFingerprint(home);
  writeFileSync(file, auth('a@example.com', 'rotated-secret'));
  expect(await readAuthIdentityFingerprint(home)).toBe(first);
  writeFileSync(file, '{'); expect(await readAuthIdentityFingerprint(home)).toBeNull();
  writeFileSync(file, 'x'.repeat(129 * 1024)); expect(await readAuthIdentityFingerprint(home)).toBeNull();
});

function createClient(email: string, percent: number, fail = false) {
  return { request: vi.fn(async (method: string) => {
    if (method === 'account/read') return { account: { type: 'chatgpt', email, planType: 'pro' } };
    if (fail) throw new Error('quota unavailable');
    return { rateLimits: { limitId: 'codex', primary: { usedPercent: percent, windowDurationMins: 10080 } } };
  }), shutdown: vi.fn() };
}

it('uses fresh login state for every quota read, including keyring-only switches', async () => {
  const a = createClient('a@example.com', 92), b = createClient('b@example.com', 2);
  const factory = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b);
  const source = new FreshCurrentAccountSource(factory, async () => 'missing');
  const old = await source.read(emptyCodexUsage());
  expect(old.account?.email).toBe('a@example.com');
  expect(await source.hasChanged()).toBe(false);
  const next = await source.read(old);
  expect(next).toMatchObject({ account: { email: 'b@example.com' }, primaryLimit: { primary: { usedPercent: 2 } } });
  expect(a.shutdown).toHaveBeenCalledTimes(1); expect(b.shutdown).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledTimes(2);
});

it('rejects quota read across an external switch even if RPC identity stays cached', async () => {
  let fingerprint = 'a'; const client = createClient('a@example.com', 92);
  const previous = await readAccountUsage(client);
  const original = client.request.getMockImplementation()!;
  client.request.mockImplementation(async method => { const result=await original(method); if(method==='account/rateLimits/read')fingerprint='b'; return result; });
  const source = new FreshCurrentAccountSource(() => client, async () => fingerprint);
  expect(await source.read(previous)).toMatchObject({ stale: true, account: { email: 'a@example.com' }, updatedAt: previous.updatedAt });
  expect(await source.hasChanged()).toBe(true);
  expect(await source.hasChanged()).toBe(false);
  expect(client.shutdown).toHaveBeenCalledTimes(1);
});

it('does not overwrite the new account with old quota when its fresh quota request fails', async () => {
  const old=await readAccountUsage(createClient('a@example.com', 92));
  const client=createClient('b@example.com', 0, true);
  const source=new FreshCurrentAccountSource(()=>client,async()=>'b');
  expect(await source.read(old)).toMatchObject({ account:{email:'b@example.com'}, limits:[],status:'error' });
  expect(client.shutdown).toHaveBeenCalledTimes(1);
});

it('retains its last identity during a partial file write then detects recovery', async () => {
  let fingerprint: string|null='a'; const source=new FreshCurrentAccountSource(()=>createClient('a@example.com', 1),async()=>fingerprint);
  expect(await source.hasChanged()).toBe(false);
  fingerprint=null; expect(await source.hasChanged()).toBe(false);
  fingerprint='b'; expect(await source.hasChanged()).toBe(true);
});
