import React from 'react';

export function PrimaryButton({ label = 'Start DuoAudio', disabled = true, onClick }) {
  return (
    <button
      type="button"
      className="btn-primary"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? 'Dual audio routing activates in Phase 5B' : label}
    >
      {label}
    </button>
  );
}
