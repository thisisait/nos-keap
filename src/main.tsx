import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Inicializuj HTTP API handler
import './services/httpApiHandler'

createRoot(document.getElementById("root")!).render(<App />);
