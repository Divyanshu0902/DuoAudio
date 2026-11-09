import React from 'react';

export function PrimaryButton({ label = 'Start Sharing', disabled = false, onClick, isStop = false, title = '' }) {
  const defaultTitle = disabled
    ? (isStop ? 'Stopping audio routing...' : 'Select two distinct audio devices to start sharing')
    : label;

  return (
    <button
      type="button"
      className={`btn-start-sharing ${isStop ? 'btn-stop-sharing' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={title || defaultTitle}
    >
      {isStop ? (
        /* Outline square stop icon */
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      ) : (
        /* Outline play icon */
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="6 3 20 12 6 21 6 3" />
        </svg>
      )}
      <span>{label}</span>
    </button>
  );
}
