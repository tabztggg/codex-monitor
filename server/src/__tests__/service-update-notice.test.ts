import { visibleServiceUpdate, type ServiceUpdate } from '../../../web/src/components/ServiceControls';

const record = (status: ServiceUpdate['status']): ServiceUpdate => ({
  supported: true, repository: 'tabztggg/codex-monitor', operationId: 'old-operation',
  status, version: '0.4.5', targetVersion: '0.4.6',
});

it.each(['completed', 'up-to-date', 'failed'] as const)('does not show a persisted %s record as a new operation', status => {
  expect(visibleServiceUpdate(record(status), undefined, '0.4.10')).toBeUndefined();
  expect(visibleServiceUpdate(record(status), 'different-operation', '0.4.10')).toBeUndefined();
});

it.each(['completed', 'up-to-date'] as const)('reconciles a watched %s against the installed version', status => {
  expect(visibleServiceUpdate(record(status), 'old-operation')).toBeUndefined();
  expect(visibleServiceUpdate(record(status), 'old-operation', '0.4.10')).toBeUndefined();
  expect(visibleServiceUpdate(record(status), 'old-operation', '0.4.6')).toEqual(record(status));
});

it('still shows active operations from another tab and failures of the operation being watched', () => {
  expect(visibleServiceUpdate(record('building'), undefined, '0.4.10')).toEqual(record('building'));
  expect(visibleServiceUpdate(record('failed'), 'old-operation', '0.4.10')).toEqual(record('failed'));
});
