import type { APIGatewayRequestAuthorizerEventV2, Context } from 'aws-lambda';
import jwt from 'jsonwebtoken';

// Os mocks precisam ser registrados antes do import do authorizer.
jest.mock('../src/config', () => ({
  carregarSegredo: jest.fn(),
}));

import { handler } from '../src/authorizer';
import { carregarSegredo } from '../src/config';

const segredoMock = carregarSegredo as jest.MockedFunction<
  typeof carregarSegredo
>;

const SEGREDO_JWT = 'segredo-de-teste-suficientemente-longo';
const OUTRO_SEGREDO = 'outra-chave-que-nao-e-a-da-api-nenhuma';

const contexto = { awsRequestId: 'req-local' } as Context;

function evento(
  headers: Record<string, string> | undefined,
): APIGatewayRequestAuthorizerEventV2 {
  return {
    type: 'REQUEST',
    headers,
    requestContext: { requestId: 'req-gateway' },
  } as unknown as APIGatewayRequestAuthorizerEventV2;
}

function comBearer(token: string): APIGatewayRequestAuthorizerEventV2 {
  return evento({ authorization: `Bearer ${token}` });
}

function base64url(objeto: unknown): string {
  return Buffer.from(JSON.stringify(objeto)).toString('base64url');
}

beforeEach(() => {
  jest.clearAllMocks();
  segredoMock.mockResolvedValue({
    DATABASE_URL: 'postgresql://localhost:5432/oficina',
    JWT_ACCESS_SECRET: SEGREDO_JWT,
  });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('authorizer do API Gateway', () => {
  it('autoriza token de cliente, como o emitido pelo POST /auth', async () => {
    const token = jwt.sign(
      {
        sub: '6f1c2a3e-0000-4000-8000-000000000001',
        nome: 'Maria Souza',
        email: 'maria@example.com',
        tipo: 'CLIENTE',
      },
      SEGREDO_JWT,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({
      isAuthorized: true,
      context: {
        sub: '6f1c2a3e-0000-4000-8000-000000000001',
        tipo: 'CLIENTE',
        email: 'maria@example.com',
      },
    });
  });

  it('autoriza token de funcionário, sem iss, aud nem tipo', async () => {
    // Formato do POST /auth/login da API: sub numérico e um único papel.
    const token = jwt.sign(
      { sub: 42, email: 'mecanico@oficina.com', roles: 'mecanico' },
      SEGREDO_JWT,
      { algorithm: 'HS256', expiresIn: '15m' },
    );

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({
      isAuthorized: true,
      context: {
        sub: '42',
        tipo: 'FUNCIONARIO',
        email: 'mecanico@oficina.com',
      },
    });
  });

  it('omite o email do contexto quando o token não traz', async () => {
    const token = jwt.sign({ sub: 7, roles: 'mecanico' }, SEGREDO_JWT, {
      algorithm: 'HS256',
    });

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({
      isAuthorized: true,
      context: { sub: '7', tipo: 'FUNCIONARIO' },
    });
  });

  it('recusa token assinado com outra chave', async () => {
    const token = jwt.sign({ sub: 1, tipo: 'CLIENTE' }, OUTRO_SEGREDO, {
      algorithm: 'HS256',
    });

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('recusa token expirado', async () => {
    const token = jwt.sign({ sub: 1 }, SEGREDO_JWT, {
      algorithm: 'HS256',
      expiresIn: -10,
    });

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('recusa quando o header authorization não existe', async () => {
    expect(await handler(evento({}), contexto)).toEqual({
      isAuthorized: false,
    });
    expect(await handler(evento(undefined), contexto)).toEqual({
      isAuthorized: false,
    });
    expect(segredoMock).not.toHaveBeenCalled();
  });

  it('não enxerga o header com a grafia Authorization', async () => {
    // O gateway entrega os nomes em minúsculo no payload 2.0; a grafia
    // original não deve ser aceita como fallback silencioso.
    const token = jwt.sign({ sub: 1 }, SEGREDO_JWT, { algorithm: 'HS256' });

    const resultado = await handler(
      evento({ Authorization: `Bearer ${token}` }),
      contexto,
    );

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('recusa header sem o prefixo Bearer', async () => {
    const token = jwt.sign({ sub: 1 }, SEGREDO_JWT, { algorithm: 'HS256' });

    expect(await handler(evento({ authorization: token }), contexto)).toEqual({
      isAuthorized: false,
    });
    expect(
      await handler(evento({ authorization: `Basic ${token}` }), contexto),
    ).toEqual({ isAuthorized: false });
  });

  it('recusa token com algoritmo none', async () => {
    const semAssinatura = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(
      { sub: 1, tipo: 'CLIENTE' },
    )}.`;

    const resultado = await handler(comBearer(semAssinatura), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('recusa token HS512, mesmo com a chave certa', async () => {
    // Prova que a lista de algoritmos é explícita e não só "o que a lib aceita".
    const token = jwt.sign({ sub: 1 }, SEGREDO_JWT, { algorithm: 'HS512' });

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('recusa token com tipo desconhecido', async () => {
    const token = jwt.sign({ sub: 1, tipo: 'ADMIN' }, SEGREDO_JWT, {
      algorithm: 'HS256',
    });

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('recusa token sem sub', async () => {
    const token = jwt.sign({ email: 'a@b.com' }, SEGREDO_JWT, {
      algorithm: 'HS256',
    });

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('recusa (fail closed) quando o segredo não carrega', async () => {
    segredoMock.mockRejectedValue(new Error('timeout no Secrets Manager'));
    const token = jwt.sign({ sub: 1 }, SEGREDO_JWT, { algorithm: 'HS256' });

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('recusa token de cliente sem o campo nome', async () => {
    // PayloadToken exige `nome`; sem ele o token não é um token de cliente legítimo.
    const token = jwt.sign(
      {
        sub: '6f1c2a3e-0000-4000-8000-000000000001',
        tipo: 'CLIENTE',
        email: 'a@b.com',
      },
      SEGREDO_JWT,
      { algorithm: 'HS256' },
    );

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('recusa token sem tipo e sem roles — impede escalada de privilégio', async () => {
    // Um token com apenas `sub` e sem `tipo` nem `roles` não satisfaz o contrato
    // de nenhum dos dois papéis: seria tratado como FUNCIONARIO mas sem roles.
    const token = jwt.sign({ sub: 1 }, SEGREDO_JWT, { algorithm: 'HS256' });

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it.each(['admin', 'funcionario', 'mecanico'])(
    'autoriza funcionário com roles %s, valor do enum da API',
    async (papel) => {
      const token = jwt.sign({ sub: 3, roles: papel }, SEGREDO_JWT, {
        algorithm: 'HS256',
      });

      const resultado = await handler(comBearer(token), contexto);

      expect(resultado).toEqual({
        isAuthorized: true,
        context: { sub: '3', tipo: 'FUNCIONARIO' },
      });
    },
  );

  it.each([
    ['fora do enum', 'superusuario'],
    ['em maiúsculo', 'ADMIN'],
    ['vazio', ''],
    ['como lista', ['mecanico']],
  ])('recusa funcionário com roles %s', async (_caso, roles) => {
    // A API emite um único valor do enum `Roles`; qualquer outra forma não é
    // um token que ela tenha assinado.
    const token = jwt.sign({ sub: 3, roles }, SEGREDO_JWT, {
      algorithm: 'HS256',
    });

    const resultado = await handler(comBearer(token), contexto);

    expect(resultado).toEqual({ isAuthorized: false });
  });

  it('não revela o motivo na resposta e não loga o token', async () => {
    const token = jwt.sign({ sub: 1 }, OUTRO_SEGREDO, { algorithm: 'HS256' });

    const resultado = await handler(comBearer(token), contexto);

    expect(Object.keys(resultado)).toEqual(['isAuthorized']);

    const warn = console.warn as jest.Mock;
    expect(warn).toHaveBeenCalledTimes(1);
    const linha = String(warn.mock.calls[0][0]);
    expect(linha).not.toContain(token);
    expect(JSON.parse(linha)).toMatchObject({
      level: 'warn',
      service: 'lambda-auth',
      correlationId: 'req-gateway',
    });
  });
});
