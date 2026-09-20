import { useState } from 'react';
import { useT } from '../../i18n';
import type { OlimpyxApi, ReportStatus } from '../../lib/api';
import { humanizeError } from '../../lib/humanizeError';

export function ReportButton({ api, target }: { api: OlimpyxApi; target: { kind: 'message' | 'profile' | 'knowledge_version'; id: string } }) {
  const { t } = useT();
  const [report, setReport] = useState<ReportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const explanation = window.prompt(t('shared.report.prompt'));
    if (!explanation?.trim()) return;
    setError(null);
    try {
      setReport(await api.report({ target, category: 'other', explanation: explanation.trim() }));
    } catch (caught) {
      setError(humanizeError(caught));
    }
  };

  const refresh = async () => {
    if (!report) return;
    try {
      setReport(await api.reportStatus(report.report_id));
    } catch (caught) {
      setError(humanizeError(caught));
    }
  };

  return (
    <span>
      <button className="text-button" onClick={() => void submit()}>{t('shared.report.action')}</button>
      {report && <button className="text-button" onClick={() => void refresh()}>{t('shared.report.status', { status: report.status })}</button>}
      {error && <small className="form-error" role="alert">{error}</small>}
    </span>
  );
}