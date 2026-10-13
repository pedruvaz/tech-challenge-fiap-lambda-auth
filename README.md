# tech-challenge-fiap-lambda-auth

Function Serverless de autenticação por CPF do Tech Challenge.

É o **terceiro** repositório da cadeia de deploy. Lê a rede do `infra-k8s` e o
segredo e o security group do `infra-db`.

## Propósito

Expõe `POST /auth`. Recebe um CPF, e:

1. **Valida o CPF** pelos dois dígitos verificadores, antes de qualquer
   consulta ao banco.
2. **Consulta o cliente** na tabela `cliente` do RDS, considerando ativo
   quem tem `deletado_em IS NULL` (o schema usa soft delete).
3. **Emite um JWT** assinado em HS256 com a `JWT_ACCESS_SECRET` do Secrets
   Manager — a mesma chave que a API usa para validar.

## Tecnologias

Node.js 20 · TypeScript · `jsonwebtoken` · `pg` · AWS SDK v3 ·
esbuild (bundle) · Jest · Terraform · GitHub Actions com OIDC.

## Contrato da API

### `POST /auth`

```jsonc
// Requisição — aceita com ou sem pontuação
{ "cpf": "529.982.247-25" }
```

```jsonc
// 200 OK
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 3600,
  "tokenType": "Bearer"
}
```

| Status | Quando |
|---|---|
| `200` | CPF válido e cliente ativo — token emitido |
| `400` | CPF ausente, malformado ou com dígito verificador errado |
| `401` | Cliente não encontrado **ou** inativo |
| `500` | Falha interna (detalhe só no log, nunca na resposta) |

Toda resposta traz o header `x-correlation-id`, que é o `requestId` do API
Gateway — é por ele que se acha a requisição no Datadog.

#### Payload do token

```jsonc
{
  "sub": "6f1c2a3e-...",   // cliente_id (UUID)
  "nome": "Maria Souza",
  "email": "maria@example.com",
  "tipo": "CLIENTE",
  "exp": 1760000000
}
```

Uso: `Authorization: Bearer <accessToken>` nas rotas protegidas.

## Arquitetura deste repositório

```
   Cliente
      │ POST /auth { cpf }
      ▼
   API Gateway ──────────────► Lambda auth  (subnets privadas)
                                   │  │
                 lê o segredo      │  │  consulta o cliente
                 (Secrets Manager) │  │  (5432, SG dedicado)
                                   ▼  ▼
                        Secrets Manager   RDS PostgreSQL
                        JWT_ACCESS_SECRET   tabela cliente
                        DATABASE_URL
      ▲
      │ Authorization: Bearer <jwt>   (mesma JWT_ACCESS_SECRET)
   app-oficina no EKS
```

## Execução local

```bash
npm ci
npm test              # 20 testes, sem precisar de AWS
npm run bundle        # gera dist/handler.js (~143 KB)
```

Os testes mockam o banco e o Secrets Manager — rodam offline. O teste central
é o que verifica o JWT emitido com a mesma chave que a API usaria: se ele
quebrar, a autenticação ponta a ponta quebrou.

## Deploy

Pré-requisito: `infra-k8s` e `infra-db` já aplicados.

```bash
npm run package       # build + bundle em dist/
cd terraform
terraform init
terraform apply
```

O Terraform empacota `../dist` num zip e publica a função. Nenhuma credencial
é passada por variável de ambiente — só o **nome** do segredo; o conteúdo é
lido em runtime.

## CI/CD

| Gatilho | O que roda |
|---|---|
| Pull request | formatação, typecheck, testes com cobertura, bundle, `terraform plan` |
| Push em `main` | o mesmo + `terraform apply` |

O bundle testado é o mesmo publicado: ele sobe como artefato no job de teste e
é baixado pelo job de deploy, em vez de ser reconstruído. Evita o clássico
"passou no CI e subiu outra coisa".

Configure: secret `AWS_TERRAFORM_ROLE_ARN`, variable `AWS_REGION`.
A branch `main` é protegida: merge só via Pull Request.

## Decisões que vale conhecer

### A Lambda roda dentro da VPC — e o preço disso

O RDS está em subnet privada e não é público, então a função precisa estar na
VPC. A consequência é que ela perde acesso à internet por padrão, e o Secrets
Manager é um serviço **público**: sem **NAT Gateway** ou **VPC endpoint**
(`com.amazonaws.<região>.secretsmanager`), a chamada ao segredo trava até o
timeout. O sintoma é enganoso — parece lentidão do banco, mas é a leitura do
segredo que não volta. A VPC do `infra-k8s` já provisiona NAT.

### Cache do segredo e do pool entre invocações

Ambos ficam em variável de escopo de módulo, que sobrevive enquanto o
container estiver quente. Poupa uma chamada cobrada ao Secrets Manager e o
handshake TLS a cada invocação morna. O cache do segredo guarda a *Promise*,
não o valor: duas invocações concorrentes no mesmo container esperam a mesma
chamada em vez de disparar duas. Uma falha é removida do cache, senão um
timeout transitório no cold start ficaria memoizado e o container devolveria
erro até ser reciclado.

O pool usa `max: 1` de propósito: cada container atende uma invocação por vez,
e com `db.t4g.micro` o limite de conexões é baixo — um pool generoso somado à
concorrência do Lambda esgota o banco.

### 401 genérico para "não existe" e para "inativo"

Distinguir os dois casos transformaria esta rota pública num oráculo para
descobrir quais CPFs são clientes da oficina. A resposta é a mesma; a
diferença fica no log.

### CPF nunca aparece no log

É dado pessoal e o log vai para um serviço de terceiro. Onde ajuda no
diagnóstico, só os 3 últimos dígitos (`***725`). Token e conteúdo do segredo
também nunca são logados.

## Pendências conhecidas

- **Rota no API Gateway.** O Gateway em si ainda não está provisionado. A
  função já exporta `lambda_invoke_arn`, que é o valor que a integração da
  rota `POST /auth` consome. Ver o plano de entrega.
- **Contrato do payload.** A API hoje tipa `JwtPayload.sub` como `number` (id
  de `usuario`) e espera `roles`; este token autentica um *cliente*, cujo id é
  UUID, e manda `tipo`. A assinatura confere — o contrato do payload precisa
  ser alinhado dos dois lados.

## Repositórios da entrega

| Repositório | Papel |
|---|---|
| [infra-k8s](https://github.com/pedruvaz/tech-challenge-fiap-infra-k8s) | VPC, EKS, ECR, OIDC |
| [infra-db](https://github.com/pedruvaz/tech-challenge-fiap-infra-db) | RDS e Secrets Manager |
| [lambda-auth](https://github.com/pedruvaz/tech-challenge-fiap-lambda-auth) | **este** — autenticação por CPF |
| [app-oficina](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina) | API da oficina no EKS |
