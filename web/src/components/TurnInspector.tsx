import type {
  ActiveShutdownState,
  MonitorItem,
  PendingRequest,
  ThreadNode,
  TurnSummary
} from "../../../shared/monitor";
import { useI18n } from '../LanguageContext';

export function TurnInspector({
  thread,
  turn,
  items,
  pendingRequests,
  activeShutdown
}: {
  thread: ThreadNode | null;
  turn: TurnSummary | null;
  items: Record<string, MonitorItem>;
  pendingRequests: PendingRequest[];
  activeShutdown: ActiveShutdownState;
}) {
  const { t, label, time } = useI18n();
  const latestCommands = turn
    ? turn.itemIds
        .map((itemId) => items[itemId])
        .filter((item): item is MonitorItem => Boolean(item))
        .filter((item) => item.type === "commandExecution")
    : [];

  return (
    <section className="panel inspector-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">{t('Inspector')}</p>
          <h3>{thread ? label(thread.runtimeStatus.bucket) : t('No thread selected')}</h3>
        </div>
      </div>

      {!thread ? (
        <div className="empty-state">{t('Thread metadata appears here.')}</div>
      ) : (
        <>
          <div className="inspector-section">
            <span className="panel-meta">{t('Latest turn')}</span>
            <strong>{turn ? label(turn.status) : t('no turn yet')}</strong>
            <span>{thread.lastCommandSummary ?? thread.latestMessagePreview ?? t('No recent activity summary.')}</span>
          </div>

          <div className="inspector-section">
            <span className="panel-meta">{t('Plan')}</span>
            {turn?.plan.length ? (
              <ul className="plan-list">
                {turn.plan.map((step) => (
                  <li key={step.step}>
                    <span className="panel-meta">{label(step.status)}</span>
                    <strong>{step.step}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <span>{t('No plan updates captured for this turn.')}</span>
            )}
          </div>

          <div className="inspector-section">
            <span className="panel-meta">{t('Diff')}</span>
            {turn?.diff ? <pre>{turn.diff}</pre> : <span>{t('No diff emitted yet.')}</span>}
          </div>

          <div className="inspector-section">
            <span className="panel-meta">{t('Commands')}</span>
            {latestCommands.length ? (
              latestCommands.map((item) => (
                <div key={item.id} className="command-summary">
                  <code className="command-line">{item.command}</code>
                  {item.output ? <pre>{item.output}</pre> : null}
                </div>
              ))
            ) : (
              <span>{t('No command output in this turn yet.')}</span>
            )}
          </div>

          <div className="inspector-section">
            <span className="panel-meta">{t('Pending requests')}</span>
            {pendingRequests.length ? (
              pendingRequests.map((request) => (
                <div key={request.id} className="pending-card">
                  <strong>{t(request.summary)}</strong>
                  <span title={request.method}>{label(request.kind)}</span>
                </div>
              ))
            ) : (
              <span>{t('No pending human requests for this thread.')}</span>
            )}
          </div>

          {activeShutdown.scheduled ? (
            <div className="inspector-section">
              <span className="panel-meta">{t('Shutdown timer')}</span>
              <strong>{activeShutdown.executeAt ? time(activeShutdown.executeAt) : label('scheduled')}</strong>
              <span>{activeShutdown.command}</span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
