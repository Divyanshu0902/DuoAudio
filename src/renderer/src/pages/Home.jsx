import React, { useState, useEffect, useCallback } from 'react';
import { DeviceCard } from '../components/DeviceCard';
import { PrimaryButton } from '../components/PrimaryButton';

export function Home() {
  const [devices, setDevices] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDevice1Id, setSelectedDevice1Id] = useState(null);
  const [selectedDevice2Id, setSelectedDevice2Id] = useState(null);

  // Independent output volume controls (default unity 80% and 100% as approved)
  const [vol1, setVol1] = useState(80);
  const [vol2, setVol2] = useState(100);

  // Unobtrusive user feedback notice
  const [feedbackNotice, setFeedbackNotice] = useState(null);

  /**
   * Fetches audio playback endpoints from main process via IPC.
   * @param {boolean} isRefresh
   */
  const fetchDevices = useCallback(async (isRefresh = false) => {
    setIsLoading(true);
    try {
      let res;
      if (window.duoAudioAPI && typeof window.duoAudioAPI.getAudioDevices === 'function') {
        res = isRefresh
          ? await window.duoAudioAPI.refreshAudioDevices()
          : await window.duoAudioAPI.getAudioDevices();
      } else {
        res = { success: false, devices: [], error: 'IPC API unavailable' };
      }

      if (res && res.success) {
        const enumerated = Array.isArray(res.devices) ? res.devices : [];
        setDevices(enumerated);

        if (!isRefresh) {
          // Initial population: assign distinct endpoints if available
          if (enumerated.length >= 2) {
            setSelectedDevice1Id(enumerated[0].id);
            setSelectedDevice2Id(enumerated[1].id);
          } else if (enumerated.length === 1) {
            setSelectedDevice1Id(enumerated[0].id);
            setSelectedDevice2Id(null);
            setFeedbackNotice({
              type: 'info',
              message: '1 playback endpoint detected. Connect a second device for simultaneous dual audio.'
            });
          } else {
            setSelectedDevice1Id(null);
            setSelectedDevice2Id(null);
            setFeedbackNotice({
              type: 'warning',
              message: 'No Windows playback endpoints detected. Please connect headphones or speakers.'
            });
          }
        } else {
          // Refresh: Validate existing selections against new device list
          let s1Id = selectedDevice1Id;
          let s2Id = selectedDevice2Id;

          // Check Slot 1
          if (s1Id !== null && !enumerated.some((d) => d.id === s1Id)) {
            s1Id = null;
            setFeedbackNotice({
              type: 'warning',
              message: 'Output 1 endpoint was disconnected or removed.'
            });
          } else if (s1Id === null && enumerated.length > 0) {
            // Re-assign if previously empty and candidate available
            const candidate = enumerated.find((d) => d.id !== s2Id);
            if (candidate) s1Id = candidate.id;
          }

          // Check Slot 2
          if (s2Id !== null && !enumerated.some((d) => d.id === s2Id)) {
            s2Id = null;
            setFeedbackNotice({
              type: 'warning',
              message: 'Output 2 endpoint was disconnected or removed.'
            });
          } else if (s2Id === null && enumerated.length >= 2) {
            const candidate = enumerated.find((d) => d.id !== s1Id);
            if (candidate) s2Id = candidate.id;
          }

          setSelectedDevice1Id(s1Id);
          setSelectedDevice2Id(s2Id);

          if (enumerated.length === 0) {
            setFeedbackNotice({
              type: 'warning',
              message: 'No playback endpoints detected on refresh.'
            });
          }
        }
      } else {
        setFeedbackNotice({
          type: 'error',
          message: `Device enumeration error: ${res ? res.error : 'Unknown failure'}`
        });
      }
    } catch (err) {
      setFeedbackNotice({
        type: 'error',
        message: `Failed to query Windows audio devices: ${err.message}`
      });
    } finally {
      setIsLoading(false);
    }
  }, [selectedDevice1Id, selectedDevice2Id]);

  // Initial enumeration on mount
  useEffect(() => {
    fetchDevices(false);
  }, []);

  // Handle device selection for Output 1
  const handleSelectDevice1 = (candidateId) => {
    if (candidateId !== null && candidateId === selectedDevice2Id) {
      const assigned = devices.find((d) => d.id === candidateId);
      const name = assigned ? assigned.name : `Endpoint ${candidateId}`;
      setFeedbackNotice({
        type: 'warning',
        message: `"${name}" is already selected for Output 2. Dual routing requires two distinct endpoints.`
      });
      return; // Reject duplicate selection, preserve current selection
    }
    setSelectedDevice1Id(candidateId);
    setFeedbackNotice(null);
  };

  // Handle device selection for Output 2
  const handleSelectDevice2 = (candidateId) => {
    if (candidateId !== null && candidateId === selectedDevice1Id) {
      const assigned = devices.find((d) => d.id === candidateId);
      const name = assigned ? assigned.name : `Endpoint ${candidateId}`;
      setFeedbackNotice({
        type: 'warning',
        message: `"${name}" is already selected for Output 1. Dual routing requires two distinct endpoints.`
      });
      return; // Reject duplicate selection, preserve current selection
    }
    setSelectedDevice2Id(candidateId);
    setFeedbackNotice(null);
  };

  const selectedDev1 = devices.find((d) => d.id === selectedDevice1Id) || null;
  const selectedDev2 = devices.find((d) => d.id === selectedDevice2Id) || null;

  return (
    <main className="content-area">
      {/* Main Heading Row: "Audio Sharing" (left) + "2 OUTPUTS" (right) */}
      <div className="heading-row">
        <h1 className="main-heading">Audio Sharing</h1>
        <span className="outputs-badge">2 OUTPUTS</span>
      </div>

      {/* Authoritative Section Heading */}
      <div className="section-heading">AVAILABLE DEVICES</div>

      {/* Device Entries List */}
      <div className="device-list">
        {/* Output 1 */}
        <DeviceCard
          slot={1}
          selectedDevice={selectedDev1}
          availableDevices={devices}
          otherSelectedId={selectedDevice2Id}
          onSelectDevice={handleSelectDevice1}
          volume={vol1}
          onVolumeChange={setVol1}
        />

        {/* Thin horizontal divider line between device entries */}
        <div className="device-divider" />

        {/* Output 2 */}
        <DeviceCard
          slot={2}
          selectedDevice={selectedDev2}
          availableDevices={devices}
          otherSelectedId={selectedDevice1Id}
          onSelectDevice={handleSelectDevice2}
          volume={vol2}
          onVolumeChange={setVol2}
        />
      </div>

      {/* Bottom Action Area */}
      <section className="bottom-actions">
        {/* Unobtrusive Feedback Notice */}
        {feedbackNotice && (
          <div className={`feedback-notice ${feedbackNotice.type}`} role="status">
            <span>{feedbackNotice.message}</span>
            <button
              type="button"
              className="feedback-notice-close"
              onClick={() => setFeedbackNotice(null)}
              aria-label="Dismiss notice"
            >
              &times;
            </button>
          </div>
        )}

        {/* Primary Start Sharing Button (Strictly Disabled during Phase 5B) */}
        <PrimaryButton label="Start Sharing" disabled={true} />

        {/* Secondary Refresh Devices Button (Triggers Live WASAPI Enumeration) */}
        <button
          type="button"
          className="btn-refresh-devices"
          disabled={isLoading}
          onClick={() => fetchDevices(true)}
          title="Query Windows for connected audio playback endpoints"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <polyline points="21 3 21 8 16 8" />
          </svg>
          <span>{isLoading ? 'Scanning Devices...' : 'Refresh Devices'}</span>
        </button>
      </section>
    </main>
  );
}
