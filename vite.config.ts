import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "0.0.0.0", // Listen on all network interfaces (IPv4 and IPv6)
    port: 8080,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://localhost:3001",
        changeOrigin: true,
        ws: true,
      },
      // MinIO is exposed in production through nginx at /storage/<bucket>/<object>
      // (see getPresignedUploadUrl / getSignedStreamUrl in server/src/services/minio.ts).
      // Mirror that mapping in dev so video uploads (PUT) and playback (GET) work
      // without a separate MinIO endpoint/CORS setup.
      "/storage": {
        target: "http://localhost:9000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/storage/, ""),
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: ['react-intersection-observer'],
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${Date.now()}.js`,
        chunkFileNames: `assets/[name]-${Date.now()}.js`,
        assetFileNames: `assets/[name]-[hash].[ext]`
      }
    }
  }
}));
