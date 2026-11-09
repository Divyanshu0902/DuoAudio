import React from 'react';

export function StatusIndicator({ status = 'Ready (Phase 5A Demo)', isRouting = false }) {
  return (
    <div className="fluent-header-card">
      <div className="fluent-header-info">
        <div className="fluent-header-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        </div>
        <div className="fluent-header-text">
          <span className="fluent-header-title">System audio duplication</span>
          <span className="fluent-header-desc">WASAPI loopback active &bull; Two outputs</span>
        </div>
      </div>

      <div className="fluent-status-badge">
        <span className={`status-dot ${isRouting ? 'routing' : 'ready'}`} />
        <span>{status}</span>
      </div>
    </div>
  );
}
