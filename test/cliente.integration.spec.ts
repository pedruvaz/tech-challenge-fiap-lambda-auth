/**
 * Teste de integração contra um Postgres de verdade.
 *
 * Existe por causa de um bug que nenhum teste com mock pegaria: a aplicação
 * grava `num_documento` **com pontuação** (`123.456.789-09`) e o handler
 * normaliza o CPF para só dígitos antes de consultar. Com a comparação
 * ingênua (`num_documento = $1`), todo cliente válido recebia 401 — sem erro
 * no log, sem exceção, nada. Só aparece batendo no banco com dado real.
 *
 * Roda apenas quando `DATABASE_URL` está definida; sem ela os casos são
 * pulados, para não quebrar `npm test` na máquina de quem não subiu o banco.
 * Na CI, o job de testes já tem o serviço de Postgres no ar.
 */
import { Pool } from 'pg';

jest.mock('../src/config', () => ({
  carregarSegredo: jest.fn(async () => ({
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_ACCESS_SECRET: 'nao-usado-neste-teste',
  })),
}));

import { buscarClienteAtivoPorCpf, encerrarPool } from '../src/cliente';

const TEM_BANCO = Boolean(process.env.DATABASE_URL);
const descreve = TEM_BANCO ? describe : describe.skip;

const CPF_PONTUADO = '111.444.777-35';
const CPF_DIGITOS = '11144477735';
const CPF_INATIVO = '52998224725';

let pool: Pool;

descreve('buscarClienteAtivoPorCpf (banco real)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    await pool.query(
      `DELETE FROM cliente WHERE regexp_replace(num_documento,'\\D','','g') = ANY($1)`,
      [[CPF_DIGITOS, CPF_INATIVO]],
    );

    // Gravado COM pontuação, como a aplicação faz.
    await pool.query(
      // `atualizado_em` é @updatedAt no Prisma: quem preenche é o client, não
      // o banco. Em SQL cru a coluna precisa ser informada à mão.
      `INSERT INTO cliente (cliente_id, num_documento, nome, telefone, email, tipo, atualizado_em)
       VALUES (gen_random_uuid(), $1, 'Cliente Pontuado', '11999999999', 'pontuado@example.com', 'pessoa_fisica', now())`,
      [CPF_PONTUADO],
    );

    // Soft delete: tem de ser tratado como inexistente.
    await pool.query(
      `INSERT INTO cliente (cliente_id, num_documento, nome, telefone, email, tipo, atualizado_em, deletado_em)
       VALUES (gen_random_uuid(), $1, 'Cliente Removido', '11988888888', 'removido@example.com', 'pessoa_fisica', now(), now())`,
      [CPF_INATIVO],
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM cliente WHERE regexp_replace(num_documento,'\\D','','g') = ANY($1)`,
      [[CPF_DIGITOS, CPF_INATIVO]],
    );
    await pool.end();
    await encerrarPool();
  });

  it('acha o cliente gravado com pontuação a partir do CPF só com dígitos', async () => {
    const cliente = await buscarClienteAtivoPorCpf(CPF_DIGITOS);

    expect(cliente).not.toBeNull();
    expect(cliente?.nome).toBe('Cliente Pontuado');
  });

  it('não devolve cliente com soft delete', async () => {
    await expect(buscarClienteAtivoPorCpf(CPF_INATIVO)).resolves.toBeNull();
  });

  it('devolve null para CPF que não existe', async () => {
    await expect(buscarClienteAtivoPorCpf('00000000191')).resolves.toBeNull();
  });
});
