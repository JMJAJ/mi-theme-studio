import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/dm-sans';
import './styles/app.css';
import './styles/shell.css';
import './styles/settings.css';
import './styles/assistant.css';

// Block the webview's own context menu and file navigation on drop; the app
// provides its own menus and handles OS drops natively.
window.addEventListener('contextmenu', (event) => {
  if (!(event.target as HTMLElement).closest('input, textarea, .cm-editor')) event.preventDefault();
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
