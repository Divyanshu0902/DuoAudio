import React from 'react';
import { VolumeSlider } from './VolumeSlider';

export function DeviceCard({
  slot,
  selectedDevice,
  availableDevices = [],
  otherSelectedId = null,
  onSelectDevice,
  volume,
  onVolumeChange
}) {
  const percentage = Math.max(0, Math.min(100, Math.round(volume)));
  const hasDevice = Boolean(selectedDevice);

  // Status description text (understated, factual)
  let statusText = 'No device selected';
  if (selectedDevice) {
    statusText = selectedDevice.isDefault
      ? 'Available (Default Windows Output)'
      : 'Available';
  } else if (availableDevices.length === 0) {
    statusText = 'Unavailable (No audio devices)';
  } else if (availableDevices.length === 1 && slot === 2) {
    statusText = 'Unavailable (Requires 2 distinct endpoints)';
  }

  const handleSelectChange = (e) => {
    const val = e.target.value;
    if (val === '') {
      onSelectDevice(null);
    } else {
      onSelectDevice(Number(val));
    }
  };

  // Multiple choices are available only if there are devices that are not already assigned to other slot
  const selectableDevices = availableDevices.filter((d) => d && d.id !== otherSelectedId);
  const showDropdownChevron = selectableDevices.length > 1;

  return (
    <div className="device-entry">
      <div className="device-top-row">
        <div className="device-identity">
          {/* Elevated charcoal icon container with periwinkle headphone outline SVG */}
          <div className="device-icon-box" aria-hidden="true" style={{ opacity: hasDevice ? 1 : 0.6 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#9AA7FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
              <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
            </svg>
          </div>

          <div className="device-meta-col">
            <div className="device-select-container">
              {availableDevices.length > 0 ? (
                <div className="device-select-wrapper">
                  <select
                    className="device-select"
                    value={selectedDevice ? selectedDevice.id : ''}
                    onChange={handleSelectChange}
                    aria-label={`Output ${slot} audio endpoint selection`}
                  >
                    {!selectedDevice && (
                      <option value="" disabled>
                        No device selected
                      </option>
                    )}
                    {availableDevices.map((dev) => {
                      const isOther = otherSelectedId !== null && dev.id === otherSelectedId;
                      return (
                        <option
                          key={dev.id}
                          value={dev.id}
                          className="device-option"
                          disabled={isOther}
                        >
                          {dev.name}{isOther ? ' [Assigned to other output]' : ''}
                        </option>
                      );
                    })}
                  </select>

                  {/* Dropdown chevron shown when alternative endpoints can be chosen */}
                  {showDropdownChevron && (
                    <svg className="device-select-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4 6L8 10L12 6" stroke="#95959C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
              ) : (
                <span className="device-name device-name-empty">No device available</span>
              )}
            </div>

            <span className="device-status">{statusText}</span>
          </div>
        </div>

        <span className="device-percentage" style={{ opacity: hasDevice ? 1 : 0.4 }}>
          {hasDevice ? `${percentage}%` : '--%'}
        </span>
      </div>

      <div style={{ opacity: hasDevice ? 1 : 0.45, pointerEvents: hasDevice ? 'auto' : 'none' }}>
        <VolumeSlider
          value={percentage}
          onChange={onVolumeChange}
          ariaLabel={`Output ${slot} volume`}
        />
      </div>
    </div>
  );
}
