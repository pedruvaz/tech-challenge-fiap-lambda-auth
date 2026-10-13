import { Pool } from 'pg';
import { carregarSegredo } from './config';

export interface Cliente {
  clienteId: string;
  nome: string;
  email: string | null;
  numDocumento: string;
}

/**
 * Pool reaproveitado entre invocações no mesmo container.
 *
 * `max: 1` de propósito: cada container do Lambda atende uma invocação por
 * vez, então um pool maior só consumiria slots de conexão do RDS sem ganho.
 * Com `db.t4g.micro` o limite de conexões é baixo e a concorrência da Lambda
 * pode ser alta — é exatamente o cenário em que um pool generoso esgota o
 * banco.
 */
let pool: Pool | undefined;

async function obterPool(): Promise<Pool> {
  if (pool) return pool;

  const { DATABASE_URL } = await carregarSegredo();

  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 1,
    // Fecha conexão ociosa antes de o RDS derrubá-la por conta própria: uma
    // conexão morta no pool vira erro na invocação seguinte.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return pool;
}

/**
 * Busca o cliente pelo CPF, considerando apenas os ativos.
 *
 * "Ativo" aqui é `deletado_em IS NULL`: o schema usa soft delete, então um
 * cliente removido continua na tabela e precisa ser tratado como inexistente
 * para fins de autenticação.
 *
 * A consulta é parametrizada — o CPF vem do corpo da requisição e é entrada
 * não confiável, ainda que já validada pelo dígito verificador.
 */
export async function buscarClienteAtivoPorCpf(
  cpf: string,
): Promise<Cliente | null> {
  const db = await obterPool();

  const { rows } = await db.query<{
    cliente_id: string;
    nome: string;
    email: string | null;
    num_documento: string;
  }>(
    `SELECT cliente_id, nome, email, num_documento
       FROM cliente
      WHERE num_documento = $1
        AND deletado_em IS NULL
      LIMIT 1`,
    [cpf],
  );

  const linha = rows[0];
  if (!linha) return null;

  return {
    clienteId: linha.cliente_id,
    nome: linha.nome,
    email: linha.email,
    numDocumento: linha.num_documento,
  };
}

/** Só para os testes: descarta o pool entre casos. */
export async function encerrarPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
