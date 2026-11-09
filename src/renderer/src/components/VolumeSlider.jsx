import React from 'react';

export function VolumeSlider({ value, onChange, ariaLabel = 'Volume' }) {
  const percentage = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div className="slider-container">
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={percentage}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="authoritative-slider"
        style={{
          background: `linear-gradient(to right, #6473F2 0%, #6473F2 ${percentage}%, #34353A ${percentage}%, #34353A 100%)`
        }}
        aria-label={ariaLabel}
      />
    </div>
  );
}
