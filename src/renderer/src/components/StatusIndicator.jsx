import React from 'react';

export function StatusIndicator({ status = 'Ready (Phase 5A Demo)', isRouting = false }) {
  return (
    <div className="status-strip">
      <span className="status-strip-label">System Audio Routing</span>
      <div className="status-strip-value">
        <span className={`status-dot ${isRouting ? 'routing' : 'ready'}`} />
        <span>{status}</span>
      </div>
    </div>
  );
}
