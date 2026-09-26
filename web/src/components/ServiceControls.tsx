import { useEffect, useState } from 'react';
import { useI18n } from '../LanguageContext';

export function ServiceControls() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [instance, setInstance] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/service', { signal: controller.signal }).then(r => r.json()).then(v => {
      if (!controller.signal.aborted) { setEnabled(Boolean(v.enabled)); setInstance(v.instance); }
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  async function control(action: 'restart' | 'stop') {
    if (!window.confirm(t(action === 'restart' ? 'Restart Monitor service?' : 'Stop Monitor? Use the desktop shortcut to start it again.'))) return;
    setBusy(true);
    try {
      const response = await fetch('/api/service', { method: 'POST', headers: {
        'Content-Type': 'application/json'
      }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      setStatus(action === 'stop' ? 'Monitor stopped. Use the desktop shortcut to start it again.' : 'Restarting Monitor…');
      if (action === 'restart') {
        // A new process has a new instance identifier. Do not mistake the old server for a completed restart.
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          try {
            const next = await fetch('/api/service', { signal: AbortSignal.timeout(1500), cache: 'no-store' }).then(r => r.json());
            if (next.instance && next.instance !== instance) { window.location.reload(); return; }
          } catch { }
        }
        setStatus('Restart not confirmed. Try the desktop shortcut.');
      }
    } catch { setStatus('Service action not confirmed. Refresh to check its state.'); setBusy(false); }
  }
  return <div className="service-controls" role="group" aria-label={t('Service')}>
    <button className="language-switch service-control-button" disabled={!enabled || busy} title={!enabled ? t('Available with a managed launcher.') : undefined} onClick={() => void control('restart')}>{t('Restart service')}</button>
    <button className="language-switch service-control-button" disabled={!enabled || busy} title={!enabled ? t('Available with a managed launcher.') : undefined} onClick={() => void control('stop')}>{t('Stop service')}</button>
    {status && <small className="service-control-status" role="status">{t(status)}</small>}
  </div>;
}
