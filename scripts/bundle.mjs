// Empacota a função num único arquivo para o Lambda.
//
// Por que bundle em vez de subir `node_modules`: o pacote fica na casa de
// centenas de KB em vez de dezenas de MB, e o cold start cai junto — o Lambda
// descompacta o artefato a cada container novo.
//
// `@aws-sdk/*` fica de fora (`external`): o runtime `nodejs20.x` já traz o SDK
// v3, então embutir só aumentaria o pacote. `pg` e `jsonwebtoken` entram.
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/handler.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/handler.js',
  sourcemap: true,
  minify: true,
  external: ['@aws-sdk/*'],
  // `pg` carrega o driver nativo `pg-native` se ele existir; não usamos e
  // sem isto o esbuild falharia ao resolver o módulo opcional.
  alias: { 'pg-native': './scripts/pg-native-stub.cjs' },
  logLevel: 'info',
});

console.log('Bundle gerado em dist/handler.js');
