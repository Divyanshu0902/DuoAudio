import React from 'react';
import { VolumeSlider } from './VolumeSlider';

export function DeviceCard({ slot, deviceName, isConnected, volume, onVolumeChange, isMock = true }) {
  return (
    <div className="device-section">
      <div className="device-section-header">
        <span className="device-slot-label">Output {slot}</span>
        <div className="device-status-badge">
          <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
          <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>

      <div className="device-info">
        <div className="device-name" title={deviceName}>{deviceName}</div>
        {isMock && (
          <div className="device-meta">
            Demo Device &bull; Phase 5B Dynamic Audio Integration
          </div>
        )}
      </div>

      <VolumeSlider
        value={volume}
        onChange={onVolumeChange}
        label="Volume"
      />
    </div>
  );
}
