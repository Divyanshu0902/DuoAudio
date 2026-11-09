import React from 'react';

export function PrimaryButton({ label = 'Start Sharing', disabled = true, onClick }) {
  return (
    <button
      type="button"
      className="btn-start-sharing"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? 'Dual audio routing activates in Phase 5B' : label}
    >
      {/* Outline play icon */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="6 3 20 12 6 21 6 3" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
