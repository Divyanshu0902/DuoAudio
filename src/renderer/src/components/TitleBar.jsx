import React from 'react';

export function TitleBar({ onOpenSettings, isSettingsOpen, onBackHome }) {
  const handleMinimize = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.duoAudioAPI && typeof window.duoAudioAPI.minimizeWindow === 'function') {
      try {
        await window.duoAudioAPI.minimizeWindow();
      } catch (err) {
        console.error('[TITLEBAR] Failed to minimize window:', err);
      }
    } else {
      console.warn('[TITLEBAR] duoAudioAPI.minimizeWindow is not available.');
    }
  };

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <svg className="titlebar-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2" y="6" width="2" height="4" rx="1" fill="#5E6BC7" />
          <rect x="6" y="3" width="2" height="10" rx="1" fill="#5E6BC7" />
          <rect x="10" y="5" width="2" height="6" rx="1" fill="#7885D9" />
          <rect x="14" y="7" width="2" height="2" rx="1" fill="#A4AEE8" />
        </svg>
        <span className="titlebar-title">DuoAudio</span>
      </div>

      <div className="titlebar-controls">
        {/* Settings button: appears EXACTLY ONCE in the main UI */}
        <button
          type="button"
          className="titlebar-btn"
          title={isSettingsOpen ? 'Back to Dashboard' : 'Settings'}
          onClick={isSettingsOpen ? onBackHome : onOpenSettings}
          aria-label={isSettingsOpen ? 'Back to Dashboard' : 'Settings'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        {/* Minimize button: hides window to tray. STRICTLY NO CLOSE BUTTON. */}
        <button
          type="button"
          className="titlebar-btn"
          title="Minimize to System Tray"
          onClick={handleMinimize}
          aria-label="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="4" y1="12" x2="20" y2="12" />
          </svg>
        </button>
      </div>
    </header>
  );
}
