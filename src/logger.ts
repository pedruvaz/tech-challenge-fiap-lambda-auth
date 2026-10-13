/**
 * Log estruturado em JSON, uma linha por evento.
 *
 * O CloudWatch e o Datadog fazem parsing automático de JSON; texto solto
 * viraria uma string opaca e não daria para filtrar por campo. O
 * `correlationId` é o que permite seguir uma requisição do API Gateway até a
 * API no EKS — é o mesmo `requestId` que o Gateway propaga.
 *
 * Regra da casa: **nunca** logar CPF, token ou qualquer campo do segredo. O
 * CPF é dado pessoal e o log vai para um serviço de terceiro. Onde ele ajuda
 * no diagnóstico, logamos só os 3 últimos dígitos.
 */
type Nivel = 'info' | 'warn' | 'error';

export interface ContextoLog {
  correlationId: string;
  [campo: string]: unknown;
}

function emitir(nivel: Nivel, mensagem: string, contexto: ContextoLog): void {
  const linha = JSON.stringify({
    level: nivel,
    message: mensagem,
    service: 'lambda-auth',
    timestamp: new Date().toISOString(),
    ...contexto,
  });

  if (nivel === 'error') console.error(linha);
  else if (nivel === 'warn') console.warn(linha);
  else console.log(linha);
}

export const log = {
  info: (mensagem: string, contexto: ContextoLog) =>
    emitir('info', mensagem, contexto),
  warn: (mensagem: string, contexto: ContextoLog) =>
    emitir('warn', mensagem, contexto),
  error: (mensagem: string, contexto: ContextoLog) =>
    emitir('error', mensagem, contexto),
};

/** Últimos 3 dígitos do CPF, para diagnóstico sem expor o documento. */
export function cpfMascarado(cpf: string): string {
  return `***${cpf.slice(-3)}`;
}
