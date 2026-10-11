import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/Coaching/',
  // Zeitpunkt des Builds - steht im Einstellungsmenü, damit man sieht, welche Version läuft.
  define: {
    __APP_BUILD__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt' statt 'autoUpdate': Eine neue Version wird im Hintergrund geladen, aber erst
      // aktiviert, wenn man im Hinweis (UpdatePrompt) auf "Neu starten" tippt. Registriert
      // wird der Service Worker dort selbst, deshalb kein automatisch eingefügtes Skript.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['apple-touch-icon.png', 'favicon.svg'],
      manifest: {
        name: 'Bodybuilding Coach',
        short_name: 'BB Coach',
        description: 'Coaching-Tracker für Gewicht, Kalorien, Makros und Ernährungspläne',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/Coaching/',
        scope: '/Coaching/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
    }),
  ],
})
