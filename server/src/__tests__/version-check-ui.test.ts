import { scheduleVersionCheck, versionCheckState, versionErrorMessages } from '../../../web/src/version-check';
import { createI18n } from '../../../web/src/localization';
import type { RepositoryVersionStatus } from '../../../shared/service-version';

const known: RepositoryVersionStatus = {
  currentVersion: '0.4.11', currentCommit: '1'.repeat(40), repositoryVersion: '0.4.11', repositoryCommit: '1'.repeat(40),
  localChanges: false, updateAvailable: false, status: 'current', stale: false,
  checkedAt: '2026-09-27T12:00:00Z', nextManualCheckAt: '2026-09-27T12:05:00Z',
};

it('distinguishes the last confirmed current result from a fresh check', () => {
  const now = Date.parse('2026-09-27T12:01:00Z');
  expect(versionCheckState(known, false, now)).toMatchObject({ current: true, lastCurrent: false, coolingDown: true });
  expect(versionCheckState({ ...known, stale: true, status: 'unavailable' }, false, now)).toMatchObject({ current: false, lastCurrent: true, unavailable: true });
  expect(versionCheckState(known, true, now)).toMatchObject({ current: false, lastCurrent: true });
  expect(versionCheckState(null, true, now)).toMatchObject({ current: false, lastCurrent: false });
});

it('does not offer an update on stale data, and releases a manual cooldown at its deadline', () => {
  const now = Date.parse(known.nextManualCheckAt!);
  expect(versionCheckState(known, false, now).coolingDown).toBe(false);
  expect(versionCheckState({ ...known, stale: true, updateAvailable: true, status: 'available' }, false, now).available).toBe(false);
});

it('translates every classified error without implying that an unknown cause is a network problem', () => {
  const zh = createI18n('zh');
  for (const message of Object.values(versionErrorMessages)) expect(zh.t(message)).not.toBe(message);
  expect(zh.t(versionErrorMessages.unknown)).not.toContain('网络');
});

describe('version wake-up scheduling', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T12:00:00Z')); });
  afterEach(() => vi.useRealTimers());
  function visibility() {
    const events = new EventTarget();
    return { hidden: false, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      change() { events.dispatchEvent(new Event('visibilitychange')); } };
  }
  it.each([5, 30])('checks once when the %s minute deadline is reached', minutes => {
    const view = visibility(), check = vi.fn();
    const stop = scheduleVersionCheck(Date.now() + minutes * 60_000, check, view);
    vi.advanceTimersByTime(minutes * 60_000 - 1); expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30); expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60_000); view.change(); expect(check).toHaveBeenCalledTimes(1);
    stop();
  });
  it('pauses a due check while hidden, then runs once when visible', () => {
    const view = visibility(), check = vi.fn();
    const stop = scheduleVersionCheck(Date.now() + 300_000, check, view);
    view.hidden = true; view.change(); vi.advanceTimersByTime(600_000);
    expect(check).not.toHaveBeenCalled();
    view.hidden = false; view.change(); vi.advanceTimersByTime(30);
    expect(check).toHaveBeenCalledTimes(1); stop();
  });
  it('cancels timers and visibility listeners on unmount', () => {
    const view = visibility(), check = vi.fn();
    const stop = scheduleVersionCheck(Date.now() + 300_000, check, view);
    stop(); vi.advanceTimersByTime(600_000); view.change(); vi.advanceTimersByTime(30);
    expect(check).not.toHaveBeenCalled();
  });
});
