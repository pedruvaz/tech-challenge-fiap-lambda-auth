import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/**
 * Segredo compartilhado entre a Lambda, a API e o authorizer do API Gateway.
 *
 * Provisionado pelo repositório `infra-db` (`terraform/secrets.tf`). O nome
 * chega por variável de ambiente, definida no Terraform desta função a partir
 * do output `api_secret_name`.
 */
export interface SegredoApi {
  DATABASE_URL: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET?: string;
}

const client = new SecretsManagerClient({});

/**
 * Cache em memória, no escopo do módulo.
 *
 * Sobrevive entre invocações enquanto o mesmo container estiver quente, o que
 * poupa uma chamada ao Secrets Manager (cobrada por requisição) e ~100 ms de
 * latência em toda invocação morna. O cold start continua pagando uma vez.
 *
 * Guardamos a *Promise*, não o valor resolvido: se duas invocações
 * concorrentes caírem no mesmo container antes da primeira resolver, as duas
 * esperam a mesma chamada em vez de disparar duas.
 */
let cache: Promise<SegredoApi> | undefined;

export function carregarSegredo(): Promise<SegredoApi> {
  if (cache) return cache;

  const secretId = process.env.API_SECRET_NAME;
  if (!secretId) {
    // Erro de configuração, não de requisição: falhar alto no cold start é
    // melhor do que devolver 500 silencioso em toda chamada.
    throw new Error('Variável de ambiente API_SECRET_NAME não definida');
  }

  cache = client
    .send(new GetSecretValueCommand({ SecretId: secretId }))
    .then((resposta) => {
      if (!resposta.SecretString) {
        throw new Error(`Segredo ${secretId} veio vazio do Secrets Manager`);
      }

      const segredo = JSON.parse(resposta.SecretString) as SegredoApi;

      if (!segredo.DATABASE_URL || !segredo.JWT_ACCESS_SECRET) {
        throw new Error(
          `Segredo ${secretId} não tem DATABASE_URL e JWT_ACCESS_SECRET`,
        );
      }

      return segredo;
    })
    .catch((erro: unknown) => {
      // Sem isto, uma falha transitória (timeout de rede no cold start) fica
      // memoizada na Promise rejeitada e o container devolve erro para sempre,
      // até ser reciclado. Limpar o cache permite que a próxima tente de novo.
      cache = undefined;
      throw erro;
    });

  return cache;
}

/** Só para os testes: descarta o cache entre casos. */
export function limparCacheDeSegredo(): void {
  cache = undefined;
}
