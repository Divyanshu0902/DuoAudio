import React from 'react';

export function Settings({ onBack }) {
  return (
    <main className="content-area">
      <div className="settings-view">
        <div className="settings-header">
          <button
            type="button"
            className="settings-back-btn"
            onClick={onBack}
            title="Back to Dashboard"
            aria-label="Back to Dashboard"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <h2 className="settings-title">Settings</h2>
        </div>

        <section>
          <div className="settings-section-label">Audio Preferences</div>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-text">
                <span className="settings-item-title">Automatic speaker muting</span>
                <span className="settings-item-desc">
                  Mutes Windows default playback endpoint during active routing; restores original state on exit.
                </span>
              </div>
              <span className="settings-badge">Active</span>
            </div>
          </div>
        </section>

        <section>
          <div className="settings-section-label">About DuoAudio</div>
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-item-title">Application shell</span>
              <span className="settings-item-meta">DuoAudio v0.1.0 (Phase 5A)</span>
            </div>
            <div className="settings-divider" />
            <div className="settings-row">
              <span className="settings-item-title">Audio engine</span>
              <span className="settings-item-meta">WASAPI Loopback + RtAudio</span>
            </div>
            <div className="settings-divider" />
            <div className="settings-row">
              <span className="settings-item-title">Platform runtime</span>
              <span className="settings-item-meta">Windows 11 / Electron 33.4</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
