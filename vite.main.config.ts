import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // Dependências NATIVAS OPCIONAIS do `ws` (Edge TTS). Não são necessárias
      // (o ws tem fallback em JS puro), mas o Rollup falha ao tentar resolvê-las
      // em build. Externalizá-las deixa o `require` em runtime, onde o ws o
      // captura e ignora. Concatena com os externals do próprio forge (array).
      external: ['bufferutil', 'utf-8-validate'],
    },
  },
});
