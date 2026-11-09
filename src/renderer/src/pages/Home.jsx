import React, { useState } from 'react';
import { StatusIndicator } from '../components/StatusIndicator';
import { DeviceCard } from '../components/DeviceCard';
import { PrimaryButton } from '../components/PrimaryButton';

export function Home() {
  const [vol1, setVol1] = useState(100);
  const [vol2, setVol2] = useState(100);
  const [refreshNotice, setRefreshNotice] = useState(null);

  const handleRefresh = () => {
    setRefreshNotice('Device enumeration will connect dynamically to the audio engine in Phase 5B.');
    setTimeout(() => setRefreshNotice(null), 3200);
  };

  return (
    <main className="content-area">
      <StatusIndicator status="Ready (Phase 5A Demo)" isRouting={false} />

      <section className="section-group">
        <div className="section-header">OUTPUT ENDPOINTS</div>
        <div className="grouped-card">
          <DeviceCard
            slot={1}
            deviceName="realme Buds T310 (Demo)"
            isConnected={true}
            volume={vol1}
            onVolumeChange={setVol1}
            isMock={true}
          />

          <div className="group-divider" />

          <DeviceCard
            slot={2}
            deviceName="Airdopes 161 (Demo)"
            isConnected={true}
            volume={vol2}
            onVolumeChange={setVol2}
            isMock={true}
          />
        </div>
      </section>

      <section className="actions-section">
        {refreshNotice && (
          <div className="action-notice" role="status">
            {refreshNotice}
          </div>
        )}
        <PrimaryButton label="Start DuoAudio (Phase 5B)" disabled={true} />
        <button type="button" className="btn-secondary" onClick={handleRefresh}>
          Refresh Devices
        </button>
      </section>
    </main>
  );
}
