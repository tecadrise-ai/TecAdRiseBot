import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';

const root = document.getElementById('root')!;

if (typeof window.tecapi === 'undefined') {
  root.innerHTML =
    '<div style="padding:24px;font-family:sans-serif">Preload failed: window.tecapi is missing. Restart TecAdRiseBot with start.bat.</div>';
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
