import React, { useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { Home } from './pages/Home';
import { Settings } from './pages/Settings';

export function App() {
  const [currentView, setCurrentView] = useState('home'); // 'home' | 'settings'

  return (
    <div className="app-container">
      <TitleBar
        isSettingsOpen={currentView === 'settings'}
        onOpenSettings={() => setCurrentView('settings')}
        onBackHome={() => setCurrentView('home')}
      />

      {currentView === 'home' && <Home />}
      {currentView === 'settings' && <Settings onBack={() => setCurrentView('home')} />}
    </div>
  );
}
