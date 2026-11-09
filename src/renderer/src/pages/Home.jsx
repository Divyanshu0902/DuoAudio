import React, { useState, useEffect, useCallback, useRef } from 'react';
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

  // Routing state machine: IDLE, STARTING, PREBUFFERING, RUNNING, PARTIALLY_DEGRADED, STOPPING, STOPPED, ERROR
  const [routingState, setRoutingState] = useState('IDLE');
  const [degradedSlot, setDegradedSlot] = useState(null);
  const [degradedError, setDegradedError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Ref to access current selections in event listeners without re-subscribing
  const selectionsRef = useRef({ selectedDevice1Id, selectedDevice2Id, vol1, vol2, devices, isSubmitting, routingState });
  useEffect(() => {
    selectionsRef.current = { selectedDevice1Id, selectedDevice2Id, vol1, vol2, devices, isSubmitting, routingState };
  });

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

  // Initial enumeration and routing status synchronization on mount
  useEffect(() => {
    fetchDevices(false);

    // Sync initial routing status from main process
    if (window.duoAudioAPI && typeof window.duoAudioAPI.getRoutingStatus === 'function') {
      window.duoAudioAPI.getRoutingStatus().then((status) => {
        if (status && status.state) {
          setRoutingState(status.state);
          if (status.state === 'PARTIALLY_DEGRADED') {
            setDegradedSlot(status.failedSlot || null);
            setDegradedError(status.error || null);
          }
        }
      }).catch(() => {});
    }

    // Subscribe to live audio service state transitions
    let unsubscribeStatus = () => {};
    if (window.duoAudioAPI && typeof window.duoAudioAPI.onRoutingStatusChanged === 'function') {
      unsubscribeStatus = window.duoAudioAPI.onRoutingStatusChanged((status) => {
        if (!status) return;
        const nextState = status.state || 'IDLE';
        setRoutingState(nextState);

        if (nextState === 'PARTIALLY_DEGRADED') {
          const slot = status.failedSlot || (status.error?.includes('output1') ? 'output1' : 'output2');
          setDegradedSlot(slot);
          setDegradedError(status.error || 'Stream error');
          setFeedbackNotice({
            type: 'warning',
            message: `Output ${slot === 'output1' ? '1' : '2'} encountered an error (${status.error || 'stream disconnected'}). The remaining output continues streaming.`
          });
        } else if (nextState === 'RUNNING') {
          setDegradedSlot(null);
          setDegradedError(null);
        } else if (nextState === 'ERROR') {
          setFeedbackNotice({
            type: 'error',
            message: status.error || 'An unexpected error occurred during audio routing.'
          });
        } else if (nextState === 'STOPPED' || nextState === 'IDLE') {
          setDegradedSlot(null);
          setDegradedError(null);
          // Requirement 9: Display unresolved endpoint mute restoration warnings when applicable
          if (status.muteState && status.muteState.unresolved) {
            setFeedbackNotice({
              type: 'warning',
              message: `Warning: "${status.muteState.endpointName || 'Default Audio Device'}" was disconnected while muted. When reconnected, it may remain muted in Windows until unmuted in Windows Settings.`
            });
          }
        }
      });
    }

    // Subscribe to Tray Start Routing trigger
    let unsubscribeTray = () => {};
    if (window.duoAudioAPI && typeof window.duoAudioAPI.onTrayTriggerStart === 'function') {
      unsubscribeTray = window.duoAudioAPI.onTrayTriggerStart(() => {
        const cur = selectionsRef.current;
        if (cur.routingState === 'IDLE' || cur.routingState === 'STOPPED' || cur.routingState === 'ERROR') {
          handleStartSharing();
        }
      });
    }

    return () => {
      unsubscribeStatus();
      unsubscribeTray();
    };
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

  // Start Sharing execution
  const handleStartSharing = async () => {
    const cur = selectionsRef.current;
    if (cur.isSubmitting) return;

    if (!cur.selectedDevice1Id || !cur.selectedDevice2Id) {
      setFeedbackNotice({
        type: 'warning',
        message: 'Please select two distinct audio devices before starting sharing.'
      });
      return;
    }

    if (cur.selectedDevice1Id === cur.selectedDevice2Id) {
      setFeedbackNotice({
        type: 'warning',
        message: 'Output 1 and Output 2 cannot be assigned to the same audio device.'
      });
      return;
    }

    setIsSubmitting(true);
    setFeedbackNotice(null);

    try {
      const payload = {
        device1Id: cur.selectedDevice1Id,
        device2Id: cur.selectedDevice2Id,
        vol1: cur.vol1 / 100,
        vol2: cur.vol2 / 100
      };

      if (!window.duoAudioAPI || typeof window.duoAudioAPI.startRouting !== 'function') {
        throw new Error('IPC startRouting API unavailable.');
      }

      const res = await window.duoAudioAPI.startRouting(payload);
      if (!res || !res.success) {
        setFeedbackNotice({
          type: 'error',
          message: res?.error || 'Failed to start dual audio routing.'
        });
      }
    } catch (err) {
      setFeedbackNotice({
        type: 'error',
        message: `Routing startup error: ${err.message}`
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Stop Sharing execution
  const handleStopSharing = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      if (!window.duoAudioAPI || typeof window.duoAudioAPI.stopRouting !== 'function') {
        throw new Error('IPC stopRouting API unavailable.');
      }

      const res = await window.duoAudioAPI.stopRouting();
      if (!res || !res.success) {
        setFeedbackNotice({
          type: 'error',
          message: res?.error || 'Failed to stop audio routing cleanly.'
        });
      }
    } catch (err) {
      setFeedbackNotice({
        type: 'error',
        message: `Routing stop error: ${err.message}`
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedDev1 = devices.find((d) => d.id === selectedDevice1Id) || null;
  const selectedDev2 = devices.find((d) => d.id === selectedDevice2Id) || null;

  // Active state calculations
  const isRoutingActive = routingState === 'RUNNING' || routingState === 'PARTIALLY_DEGRADED' || routingState === 'PREBUFFERING';
  const isStarting = routingState === 'STARTING';
  const isStopping = routingState === 'STOPPING';
  const isBusy = isSubmitting || isStarting || isStopping;

  const isStopAction = isRoutingActive || isStopping;
  let buttonLabel = 'Start Sharing';
  if (isStarting) {
    buttonLabel = 'Starting...';
  } else if (isStopping) {
    buttonLabel = 'Stopping...';
  } else if (isRoutingActive) {
    buttonLabel = 'Stop Sharing';
  }

  const isStartDisabled = !selectedDevice1Id || !selectedDevice2Id || selectedDevice1Id === selectedDevice2Id || isLoading || isBusy;
  const isButtonDisabled = isStopAction ? isBusy : isStartDisabled;

  const handlePrimaryButtonClick = () => {
    if (isStopAction) {
      handleStopSharing();
    } else {
      handleStartSharing();
    }
  };

  // Dynamic header badge text
  let badgeText = '2 OUTPUTS';
  if (routingState === 'RUNNING') {
    badgeText = 'STREAMING';
  } else if (routingState === 'PARTIALLY_DEGRADED') {
    badgeText = 'DEGRADED';
  } else if (routingState === 'STARTING' || routingState === 'PREBUFFERING') {
    badgeText = 'STARTING...';
  } else if (routingState === 'STOPPING') {
    badgeText = 'STOPPING...';
  }

  return (
    <main className="content-area">
      {/* Main Heading Row: "Audio Sharing" (left) + dynamic badge (right) */}
      <div className="heading-row">
        <h1 className="main-heading">Audio Sharing</h1>
        <span className="outputs-badge">{badgeText}</span>
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
          isStreaming={isRoutingActive && degradedSlot !== 'output1'}
          isDegraded={degradedSlot === 'output1'}
          degradedError={degradedSlot === 'output1' ? degradedError : null}
          disabled={isRoutingActive || isBusy}
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
          isStreaming={isRoutingActive && degradedSlot !== 'output2'}
          isDegraded={degradedSlot === 'output2'}
          degradedError={degradedSlot === 'output2' ? degradedError : null}
          disabled={isRoutingActive || isBusy}
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

        {/* Primary Start / Stop Sharing Button */}
        <PrimaryButton
          label={buttonLabel}
          disabled={isButtonDisabled}
          isStop={isStopAction}
          onClick={handlePrimaryButtonClick}
        />

        {/* Secondary Refresh Devices Button (Triggers Live WASAPI Enumeration) */}
        <button
          type="button"
          className="btn-refresh-devices"
          disabled={isLoading || isRoutingActive || isBusy}
          onClick={() => fetchDevices(true)}
          title={isRoutingActive ? 'Cannot refresh devices while streaming is active' : 'Query Windows for connected audio playback endpoints'}
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
