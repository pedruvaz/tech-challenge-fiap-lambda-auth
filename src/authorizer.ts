import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerResult,
  APIGatewaySimpleAuthorizerWithContextResult,
  Context,
} from 'aws-lambda';
import jwt from 'jsonwebtoken';
import { carregarSegredo } from './config';
import { log } from './logger';

/**
 * Contexto que o gateway repassa para a API (`requestContext.authorizer.lambda`).
 *
 * Os valores do contexto de uma resposta simples só podem ser string, número
 * ou booleano, por isso `sub` vai sempre como string — o id do cliente é UUID
 * e o do funcionário é numérico, e a API não precisa adivinhar qual veio.
 */
export interface ContextoAutorizado {
  sub: string;
  tipo: 'CLIENTE' | 'FUNCIONARIO';
  email?: string;
}

type Resultado =
  | APIGatewaySimpleAuthorizerWithContextResult<ContextoAutorizado>
  | APIGatewaySimpleAuthorizerResult;

/**
 * Resposta de recusa. Sem `context` e sem motivo: quem chama só fica sabendo
 * que foi barrado. O motivo real (expirado, assinatura inválida, header
 * ausente) vai para o log, nunca para a resposta — senão o gateway viraria um
 * oráculo para quem tenta forjar token.
 */
const NEGADO: APIGatewaySimpleAuthorizerResult = { isAuthorized: false };

/**
 * Extrai o token do header `Authorization: Bearer <token>`.
 *
 * O nome do header é lido em **minúsculo**: no payload format 2.0 o API
 * Gateway normaliza os nomes dos headers para minúsculo, então
 * `headers.Authorization` simplesmente não existe e todo token seria tratado
 * como ausente.
 */
function extrairToken(evento: APIGatewayRequestAuthorizerEventV2): string {
  const header = evento.headers?.authorization;
  if (!header) throw new Error('Header authorization ausente');

  const partes = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!partes?.[1]) throw new Error('Header authorization sem prefixo Bearer');

  return partes[1];
}

/**
 * Converte o payload verificado no contexto repassado à API.
 *
 * Esta função é a decisão central do authorizer: **ele aceita os dois
 * formatos de token que circulam no sistema**, e por isso não exige `tipo`.
 *
 *   - cliente, emitido pela função `POST /auth` deste repositório:
 *       `{ sub: <uuid>, nome, email, tipo: 'CLIENTE' }`
 *   - funcionário, emitido pelo `POST /auth/login` da API desde a Fase 1:
 *       `{ sub: <number>, email, roles }` — sem `iss`, `aud` nem `tipo`.
 *
 * Se o authorizer exigisse `tipo: 'CLIENTE'`, todo funcionário seria barrado
 * no gateway antes de chegar à API, e nem o login de funcionário (que devolve
 * esse token) teria utilidade. Quem não traz `tipo` é tratado como
 * `FUNCIONARIO`. A autorização fina (roles, dono do recurso) continua sendo
 * da API; o gateway só garante que o token é nosso e está válido.
 */
function montarContexto(payload: string | jwt.JwtPayload): ContextoAutorizado {
  if (typeof payload === 'string') throw new Error('Payload do token inválido');

  const { sub, tipo, email } = payload;

  const subValido =
    (typeof sub === 'string' && sub !== '') ||
    (typeof sub === 'number' && Number.isFinite(sub));
  if (!subValido) throw new Error('Token sem sub válido');

  if (tipo !== undefined && tipo !== 'CLIENTE') {
    throw new Error('Token com tipo desconhecido');
  }

  const contexto: ContextoAutorizado = {
    sub: String(sub),
    tipo: tipo === 'CLIENTE' ? 'CLIENTE' : 'FUNCIONARIO',
  };
  if (typeof email === 'string' && email !== '') contexto.email = email;

  return contexto;
}

export async function handler(
  evento: APIGatewayRequestAuthorizerEventV2,
  contexto: Context,
): Promise<Resultado> {
  const correlationId =
    evento.requestContext?.requestId ?? contexto.awsRequestId;

  try {
    const token = extrairToken(evento);

    // Mesmo segredo e mesmo caminho de leitura da função de login — com o
    // cache de módulo de `config.ts`, uma invocação morna não toca a rede.
    const { JWT_ACCESS_SECRET } = await carregarSegredo();

    // `algorithms` explícito fecha a porta para `alg: none` e para a troca de
    // algoritmo: sem a lista, o que decide como verificar é o header do
    // próprio token, que é entrada do atacante.
    const payload = jwt.verify(token, JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
    });

    const autorizado = montarContexto(payload);

    log.info('Token autorizado', {
      correlationId,
      tipo: autorizado.tipo,
      sub: autorizado.sub,
    });

    return { isAuthorized: true, context: autorizado };
  } catch (erro) {
    // O token nunca entra no log; só a mensagem do erro (ex.: "jwt expired").
    log.warn('Requisicao nao autorizada', {
      correlationId,
      motivo: erro instanceof Error ? erro.message : String(erro),
    });

    return NEGADO;
  }
}
