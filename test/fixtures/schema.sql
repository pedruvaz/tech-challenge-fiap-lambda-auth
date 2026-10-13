-- Subconjunto mínimo do schema, só o que esta função lê.
--
-- A fonte da verdade é o Prisma do `app-oficina`
-- (`prisma/schema.prisma`, tabela `cliente`). Aqui ficam apenas as colunas
-- que `buscarClienteAtivoPorCpf` consulta, para a CI conseguir subir um banco
-- e rodar o teste de integração sem depender do outro repositório.
--
-- Se a coluna `num_documento` ou `deletado_em` mudar de nome ou tipo lá, este
-- arquivo precisa acompanhar — e o teste de integração é justamente o que vai
-- apontar a divergência.

CREATE TABLE IF NOT EXISTS cliente (
  cliente_id    uuid PRIMARY KEY,
  num_documento text        NOT NULL UNIQUE,
  nome          text        NOT NULL,
  telefone      text        NOT NULL,
  email         text        UNIQUE,
  tipo          text        NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL,
  deletado_em   timestamptz
);
