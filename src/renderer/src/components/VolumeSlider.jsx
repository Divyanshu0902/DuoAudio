import React from 'react';

export function VolumeSlider({ value, onChange, label = 'Gain' }) {
  const percentage = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div className="volume-control">
      <div className="volume-header">
        <span className="volume-label">{label}</span>
        <span className="volume-value">{percentage}%</span>
      </div>
      <div className="volume-slider-wrapper">
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={percentage}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          className="volume-slider"
          style={{
            background: `linear-gradient(to right, #5E6BC7 0%, #5E6BC7 ${percentage}%, #292A2D ${percentage}%, #292A2D 100%)`
          }}
          aria-label={label}
        />
      </div>
    </div>
  );
}
