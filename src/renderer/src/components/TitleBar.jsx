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
        {/* Original DuoAudio equalizer audio bars logo matching user reference */}
        <svg className="titlebar-icon" width="16" height="14" viewBox="0 0 16 14" fill="none" aria-hidden="true">
          <rect x="1" y="5" width="2" height="4" rx="1" fill="#5E6BC7" />
          <rect x="5" y="1" width="2" height="12" rx="1" fill="#5E6BC7" />
          <rect x="9" y="3" width="2" height="8" rx="1" fill="#5E6BC7" />
          <rect x="13" y="6" width="2" height="2" rx="1" fill="#8E99DF" />
        </svg>
        <span className="titlebar-title">DuoAudio</span>
      </div>

      <div className="titlebar-controls">
        {/* Settings button: opens/closes Settings */}
        <button
          type="button"
          className="titlebar-btn"
          title={isSettingsOpen ? 'Back to Dashboard' : 'Settings'}
          onClick={isSettingsOpen ? onBackHome : onOpenSettings}
          aria-label={isSettingsOpen ? 'Back to Dashboard' : 'Settings'}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
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
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="3" y1="12" x2="21" y2="12" />
          </svg>
        </button>
      </div>
    </header>
  );
}
