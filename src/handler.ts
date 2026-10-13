import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import jwt from 'jsonwebtoken';
import { buscarClienteAtivoPorCpf } from './cliente';
import { carregarSegredo } from './config';
import { cpfValido, normalizarCpf } from './cpf';
import { cpfMascarado, log } from './logger';

/** Validade do access token. Curta de propósito: não há revogação. */
const EXPIRACAO_TOKEN = '1h';

/**
 * Conteúdo do JWT emitido.
 *
 * `sub` é o `cliente_id` (UUID). A API valida a assinatura com a mesma
 * `JWT_ACCESS_SECRET` do Secrets Manager e lê este payload.
 *
 * ⚠️ Ponto de integração em aberto: a API hoje tipa `JwtPayload.sub` como
 * `number` (id de `usuario`) e espera `roles`. Este token autentica um
 * *cliente*, cujo id é UUID. A assinatura confere, mas o contrato do payload
 * precisa ser alinhado dos dois lados — ver a task "Alinhar contrato do JWT"
 * no plano de entrega.
 */
interface PayloadToken {
  sub: string;
  nome: string;
  email: string | null;
  tipo: 'CLIENTE';
}

function resposta(
  status: number,
  corpo: Record<string, unknown>,
  correlationId: string,
): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json',
      // Devolver o id de correlação permite que o cliente o cite num
      // chamado de suporte e a gente ache a requisição exata no Datadog.
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify(corpo),
  };
}

export async function handler(
  evento: APIGatewayProxyEventV2,
  contexto: Context,
): Promise<APIGatewayProxyResultV2> {
  // O API Gateway propaga o próprio requestId; o awsRequestId cobre invocação
  // direta e testes.
  const correlationId =
    evento.requestContext?.requestId ?? contexto.awsRequestId;
  const inicio = Date.now();

  try {
    let cpfBruto: unknown;

    try {
      const corpo: unknown = JSON.parse(evento.body ?? '{}');
      cpfBruto = (corpo as { cpf?: unknown })?.cpf;
    } catch {
      log.warn('Corpo da requisicao nao e JSON valido', { correlationId });
      return resposta(400, { mensagem: 'Corpo inválido' }, correlationId);
    }

    if (typeof cpfBruto !== 'string' || cpfBruto.trim() === '') {
      log.warn('Requisicao sem CPF', { correlationId });
      return resposta(400, { mensagem: 'CPF é obrigatório' }, correlationId);
    }

    const cpf = normalizarCpf(cpfBruto);

    if (!cpfValido(cpf)) {
      log.warn('CPF invalido', { correlationId, cpf: cpfMascarado(cpf) });
      return resposta(400, { mensagem: 'CPF inválido' }, correlationId);
    }

    const cliente = await buscarClienteAtivoPorCpf(cpf);

    if (!cliente) {
      // 401 e não 404, e com mensagem genérica: distinguir "não existe" de
      // "existe mas está inativo" transformaria esta rota pública num
      // oráculo para descobrir quais CPFs são clientes da oficina.
      log.warn('Cliente nao encontrado ou inativo', {
        correlationId,
        cpf: cpfMascarado(cpf),
      });
      return resposta(
        401,
        { mensagem: 'Cliente não encontrado ou inativo' },
        correlationId,
      );
    }

    const { JWT_ACCESS_SECRET } = await carregarSegredo();

    const payload: PayloadToken = {
      sub: cliente.clienteId,
      nome: cliente.nome,
      email: cliente.email,
      tipo: 'CLIENTE',
    };

    const token = jwt.sign(payload, JWT_ACCESS_SECRET, {
      expiresIn: EXPIRACAO_TOKEN,
      algorithm: 'HS256',
    });

    log.info('Autenticacao concluida', {
      correlationId,
      clienteId: cliente.clienteId,
      duracaoMs: Date.now() - inicio,
    });

    return resposta(
      200,
      { accessToken: token, expiresIn: 3600, tokenType: 'Bearer' },
      correlationId,
    );
  } catch (erro) {
    // Mensagem de erro nunca vaza para o cliente: pode conter host do banco
    // ou trecho de connection string.
    log.error('Falha inesperada na autenticacao', {
      correlationId,
      erro: erro instanceof Error ? erro.message : String(erro),
      duracaoMs: Date.now() - inicio,
    });

    return resposta(500, { mensagem: 'Erro interno' }, correlationId);
  }
}
