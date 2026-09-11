import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { audio } from './game/Audio';
import { AuthProvider } from './state/AuthContext';
import { PlatformProvider } from './state/PlatformContext';
import { ToastProvider } from './state/toast';
import './styles/global.css';
import './styles/landing.css';
import './styles/game.css';
import './styles/admin.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter>
      <PlatformProvider>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </PlatformProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

// Browsers only allow audio after a gesture, so the graph is created on the
// first pointer/key interaction anywhere in the app.
const unlock = (): void => {
  void audio.unlock();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });
