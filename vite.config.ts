import { modelAcquisitionPlugin } from './server/model-acquisition-middleware'
import { defineConfig } from 'vite'
import { aiGatewayPlugin } from './server/ai-middleware'
import { modelLibraryPlugin } from './server/model-library'
import { ltspiceSymbolPlugin } from './server/ltspice-symbol-library'
import { agentGatewayPlugin } from './server/agent-middleware'
import { modelSearchPlugin } from './server/model-search-plugin'
import { codexGatewayPlugin } from './server/codex-middleware'
import { cursorGatewayPlugin } from './server/cursor-middleware'
import { dshLocalGatewayPlugin } from './server/dsh-local-middleware'
import { codexSessionPlugin } from './server/codex-session-middleware'
import { desktopCircuitPlugin } from './server/desktop-circuit-middleware'
import type { DesktopCircuitManager } from './server/desktop-circuit-manager'
import { desktopControlPlugin } from './server/desktop-control-middleware'
import { hapiGatewayPlugin } from './server/hapi-middleware'
import { privateLocalFilesPlugin, PRIVATE_LOCAL_DENY } from './server/private-local-files'
import { userLibraryPlugin } from './server/user-library-middleware'

let circuitManager: DesktopCircuitManager | undefined
export default defineConfig({
  // Test HTML has dedicated servers and may import test-only virtual modules.
  // Scan the application entry on startup; other pages remain available on demand.
  optimizeDeps: { entries: ['index.html'] },
  plugins: [privateLocalFilesPlugin(), userLibraryPlugin(), desktopCircuitPlugin({ onManager(manager) { circuitManager = manager } }), desktopControlPlugin({ getCircuitManager: () => circuitManager }), hapiGatewayPlugin(), modelAcquisitionPlugin(), aiGatewayPlugin(), modelLibraryPlugin(), ltspiceSymbolPlugin(), modelSearchPlugin(), agentGatewayPlugin(), codexGatewayPlugin(), cursorGatewayPlugin(), dshLocalGatewayPlugin(), codexSessionPlugin()],
  server: {
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...PRIVATE_LOCAL_DENY] },
    // Local model archives and generated reports are data, not source modules.
    // Watching them wastes startup work and locked report files can restart the
    // service, discarding its in-memory catalog while a user is browsing it.
    watch: { ignored: ['**/model-library/**', '**/docs/artifacts/**', '**/docs/research/**', '**/verification/**', '**/public/deliveries/**', ...PRIVATE_LOCAL_DENY] },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 22000 },
})
