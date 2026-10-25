import type { IntegrationStatus } from '@cubbie/shared/types';
import type { Api } from '../api';
import { LocalConnections } from './LocalConnections';
import { TesseractWorkspace } from './TesseractWorkspace';

export function Settings({ api, status, onError, onJoin }: { api: Api; status: IntegrationStatus | null; onError: (message: string) => void; onJoin: () => void }) {
  return <div className="account-layout">
    {api.local && <LocalConnections local={api.local} status={status} onError={onError} />}
    <div className="join-dashboard-row"><button className="primary join-dashboard" onClick={onJoin}>Join dashboard <span aria-hidden="true">→</span></button><p>Connect your accounts now or get started without them.</p></div>
    <aside className="account-discord"><TesseractWorkspace query="" setupOnly /></aside>
  </div>;
}
