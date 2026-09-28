import { useState } from 'react';
import { buildUsageReport, usageReportFile, type ReportExportInput, type UsageReportFormat } from '../report-export';
import { useI18n } from '../LanguageContext';
import './ReportExport.css';

export type ReportExportProps = Omit<ReportExportInput, 'includeDisplayNames' | 'exportedAt'> & { disabled?: boolean };

export function ReportExport({ disabled = false, ...input }: ReportExportProps) {
  const { t, language } = useI18n();
  const [includeDisplayNames, setIncludeDisplayNames] = useState(false);
  const [notice, setNotice] = useState<'ready' | 'downloaded' | 'failed'>('ready');
  function download(format: UsageReportFormat) {
    let url: string | null = null;
    try {
      const file = usageReportFile(buildUsageReport({ ...input, includeDisplayNames }), format, language);
      url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setNotice('downloaded');
    } catch {
      setNotice('failed');
    } finally {
      if (url) {
        // One-shot cleanup after the browser has accepted the download.
        const downloadUrl = url;
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
      }
    }
  }
  return <details className="report-export">
    <summary>{t('Export report')}</summary>
    <div className="report-export-content">
      <p>{t('Exports the selected range across accounts, including hidden rows and the selected archive scope.')}</p>
      <label><input type="checkbox" checked={includeDisplayNames} onChange={event => setIncludeDisplayNames(event.target.checked)} />{t('Include task and project display names')}</label>
      <p className="muted-note">{t('Names are replaced with aliases by default. Prompts, paths and account identity are always omitted.')}</p>
      <div className="report-export-actions">
        <button type="button" disabled={disabled || !input.analysis} onClick={() => download('html')}>{t('Download HTML')}</button>
        <button type="button" disabled={disabled || !input.analysis} onClick={() => download('csv')}>{t('Download CSV')}</button>
        <button type="button" disabled={disabled || !input.analysis} onClick={() => download('json')}>{t('Download JSON')}</button>
      </div>
      {notice !== 'ready' && <p role="status" className={notice === 'failed' ? 'error-text' : 'muted-note'}>{notice === 'failed' ? t('Report export failed.') : t('Download started.')}</p>}
    </div>
  </details>;
}
