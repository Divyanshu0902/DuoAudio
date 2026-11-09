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
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <h2 className="settings-title">Settings</h2>
        </div>

        <section className="section-group">
          <div className="section-header">AUDIO PREFERENCES</div>
          <div className="grouped-card">
            <div className="settings-row">
              <div className="settings-row-text">
                <span className="settings-item-title">Automatic Speaker Muting</span>
                <span className="settings-item-desc">
                  Mutes Windows default playback endpoint during active routing; restores original state on exit.
                </span>
              </div>
              <span className="settings-badge-active">Active</span>
            </div>
          </div>
        </section>

        <section className="section-group">
          <div className="section-header">SYSTEM & RUNTIME</div>
          <div className="grouped-card">
            <div className="settings-row">
              <span className="settings-item-title">Application Shell</span>
              <span className="settings-item-meta">DuoAudio v0.1.0 (Phase 5A)</span>
            </div>
            <div className="group-divider" />
            <div className="settings-row">
              <span className="settings-item-title">Audio Engine</span>
              <span className="settings-item-meta">WASAPI Loopback + RtAudio</span>
            </div>
            <div className="group-divider" />
            <div className="settings-row">
              <span className="settings-item-title">Platform Runtime</span>
              <span className="settings-item-meta">Windows 11 / Electron 33.4</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
