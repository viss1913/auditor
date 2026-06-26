import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = (env.VITE_PROXY_TARGET || 'http://127.0.0.1:3001').replace(/\/$/, '')
  const proxyCommon = {
    target: proxyTarget,
    changeOrigin: true,
    secure: false,
    timeout: 1_800_000,
    proxyTimeout: 1_800_000,
  }

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      strictPort: false,
      proxy: {
        '/api': proxyCommon,
        '/ping': proxyCommon,
        '/upload': proxyCommon,
        '/trades': proxyCommon,
        '/audit': proxyCommon,
      },
    },
  }
})
