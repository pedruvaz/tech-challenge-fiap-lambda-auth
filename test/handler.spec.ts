import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import jwt from 'jsonwebtoken';

// Os mocks precisam ser registrados antes do import do handler.
jest.mock('../src/cliente', () => ({
  buscarClienteAtivoPorCpf: jest.fn(),
}));

jest.mock('../src/config', () => ({
  carregarSegredo: jest.fn(),
}));

import { buscarClienteAtivoPorCpf } from '../src/cliente';
import { carregarSegredo } from '../src/config';
import { handler } from '../src/handler';

const buscarMock = buscarClienteAtivoPorCpf as jest.MockedFunction<
  typeof buscarClienteAtivoPorCpf
>;
const segredoMock = carregarSegredo as jest.MockedFunction<
  typeof carregarSegredo
>;

const SEGREDO_JWT = 'segredo-de-teste-suficientemente-longo';
const CPF_VALIDO = '529.982.247-25';

const contexto = { awsRequestId: 'req-local' } as Context;

function evento(corpo: unknown): APIGatewayProxyEventV2 {
  return {
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    requestContext: { requestId: 'req-gateway' },
  } as unknown as APIGatewayProxyEventV2;
}

function corpoDe(resultado: unknown): Record<string, unknown> {
  const r = resultado as { body: string };
  return JSON.parse(r.body) as Record<string, unknown>;
}

function statusDe(resultado: unknown): number {
  return (resultado as { statusCode: number }).statusCode;
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

describe('handler de autenticação', () => {
  it('emite um JWT assinado quando o cliente está ativo', async () => {
    buscarMock.mockResolvedValue({
      clienteId: '6f1c2a3e-0000-4000-8000-000000000001',
      nome: 'Maria Souza',
      email: 'maria@example.com',
      numDocumento: '52998224725',
    });

    const resultado = await handler(evento({ cpf: CPF_VALIDO }), contexto);

    expect(statusDe(resultado)).toBe(200);

    const corpo = corpoDe(resultado);
    expect(corpo.tokenType).toBe('Bearer');

    // O teste que importa: o token precisa verificar com a mesma chave que a
    // API usa. Se isto quebrar, a autenticação ponta a ponta quebrou.
    const payload = jwt.verify(corpo.accessToken as string, SEGREDO_JWT) as {
      sub: string;
      tipo: string;
      nome: string;
    };

    expect(payload.sub).toBe('6f1c2a3e-0000-4000-8000-000000000001');
    expect(payload.tipo).toBe('CLIENTE');
    expect(payload.nome).toBe('Maria Souza');
  });

  it('busca o cliente com o CPF já normalizado', async () => {
    buscarMock.mockResolvedValue({
      clienteId: 'id',
      nome: 'Maria',
      email: null,
      numDocumento: '52998224725',
    });

    await handler(evento({ cpf: CPF_VALIDO }), contexto);

    expect(buscarMock).toHaveBeenCalledWith('52998224725');
  });

  it('devolve 400 para CPF com dígito verificador errado', async () => {
    const resultado = await handler(
      evento({ cpf: '529.982.247-26' }),
      contexto,
    );

    expect(statusDe(resultado)).toBe(400);
    expect(corpoDe(resultado).mensagem).toBe('CPF inválido');
    // Não deve nem consultar o banco.
    expect(buscarMock).not.toHaveBeenCalled();
  });

  it('devolve 400 quando o CPF não foi informado', async () => {
    const resultado = await handler(evento({}), contexto);

    expect(statusDe(resultado)).toBe(400);
    expect(corpoDe(resultado).mensagem).toBe('CPF é obrigatório');
  });

  it('devolve 400 quando o corpo não é JSON', async () => {
    const resultado = await handler(evento('isto nao e json'), contexto);

    expect(statusDe(resultado)).toBe(400);
  });

  it('devolve 401 genérico quando o cliente não existe ou está inativo', async () => {
    buscarMock.mockResolvedValue(null);

    const resultado = await handler(evento({ cpf: CPF_VALIDO }), contexto);

    expect(statusDe(resultado)).toBe(401);
    // Mensagem genérica de propósito: não entregar se o CPF é cliente.
    expect(corpoDe(resultado).mensagem).toBe(
      'Cliente não encontrado ou inativo',
    );
  });

  it('devolve 500 sem vazar detalhe do erro interno', async () => {
    buscarMock.mockRejectedValue(
      new Error('connection to host db.interno falhou'),
    );

    const resultado = await handler(evento({ cpf: CPF_VALIDO }), contexto);

    expect(statusDe(resultado)).toBe(500);
    expect(JSON.stringify(corpoDe(resultado))).not.toContain('db.interno');
  });

  it('propaga o requestId do API Gateway como id de correlação', async () => {
    buscarMock.mockResolvedValue(null);

    const resultado = (await handler(
      evento({ cpf: CPF_VALIDO }),
      contexto,
    )) as {
      headers: Record<string, string>;
    };

    expect(resultado.headers['x-correlation-id']).toBe('req-gateway');
  });
});
