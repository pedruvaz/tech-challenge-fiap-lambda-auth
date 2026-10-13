# API Gateway HTTP API: porta de entrada pública do sistema.
#
# Duas famílias de rota:
#   - `POST /auth`   -> Lambda de login por CPF, sem authorizer (é o login).
#   - o resto        -> API do `app-oficina` no EKS, via NLB. Só existe quando
#                       `api_nlb_hostname` está preenchido.

locals {
  # Rotas explícitas e sem authorizer, com o caminho que a API recebe.
  #
  # Rota explícita tem precedência sobre `$default`, e é por isso que elas
  # existem: sem elas, o `$default` (que exige token) engoliria tudo, e
  #   - o funcionário não conseguiria nem se logar (`/auth/login` e
  #     `/auth/refresh` é que entregam o token);
  #   - os links de aprovação que o cliente recebe por e-mail (`/aprovacao`),
  #     que a API expõe sem JWT, dariam 401 no gateway;
  #   - o health check e as consultas públicas de OS ficariam atrás de token.
  #
  # O caminho de destino repete o prefixo da rota. O API Gateway não manda o
  # caminho original para o backend numa integração com `{proxy}`: manda só o
  # que a variável capturou. Em `GET /health/{proxy+}`, `/health/liveness` vira
  # `proxy = liveness`, e a API (que não tem prefixo global) atende
  # `/health/liveness`, não `/liveness`.
  rotas_publicas = {
    "GET /health/{proxy+}"     = "/health/{proxy}"
    "POST /auth/login"         = "/auth/login"
    "POST /auth/refresh"       = "/auth/refresh"
    "GET /publico/{proxy+}"    = "/publico/{proxy}"
    "GET /aprovacao/{proxy+}"  = "/aprovacao/{proxy}"
    "POST /aprovacao/{proxy+}" = "/aprovacao/{proxy}"
  }

  # O gateway sobe antes do cluster: o hostname do NLB só existe depois que o
  # Service do `app-oficina` é criado. Vazio, nenhuma rota da API é criada e o
  # `terraform apply` não tem o que apontar para um destino inexistente.
  expor_api = var.api_nlb_hostname != ""
  api_url   = "http://${var.api_nlb_hostname}:${var.api_nlb_port}"
}

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"
  description   = "Entrada pública: login por CPF (Lambda) e API da oficina (EKS)."

  cors_configuration {
    # Sem cookies: a autenticação é por header `Authorization`, então liberar
    # qualquer origem não expõe credencial de sessão. Restrinja aqui se um
    # front-end com domínio fixo passar a consumir a API.
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type", "x-correlation-id"]
    max_age       = 300
  }
}

# Log group do access log, com retenção. O API Gateway não cria nem limpa este
# grupo; sem retenção explícita ele cresceria para sempre.
resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${var.project_name}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn

    # JSON, como o log das funções. Não inclui headers: o `Authorization`
    # nunca deve ir para o log. `requestId` é o `correlationId` das Lambdas.
    format = jsonencode({
      requestId           = "$context.requestId"
      ip                  = "$context.identity.sourceIp"
      requestTime         = "$context.requestTime"
      httpMethod          = "$context.httpMethod"
      routeKey            = "$context.routeKey"
      path                = "$context.path"
      status              = "$context.status"
      protocol            = "$context.protocol"
      responseLength      = "$context.responseLength"
      responseLatency     = "$context.responseLatency"
      integrationStatus   = "$context.integrationStatus"
      integrationError    = "$context.integrationErrorMessage"
      authorizerError     = "$context.authorizer.error"
      authorizerPrincipal = "$context.authorizer.principalId"
    })
  }
}

# --- POST /auth: login por CPF -------------------------------------------------

resource "aws_apigatewayv2_integration" "auth" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.auth.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# Sem authorizer: é a rota que emite o token, exigir token aqui seria circular.
resource "aws_apigatewayv2_route" "auth" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /auth"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_lambda_permission" "api_gateway_auth" {
  statement_id  = "AllowAPIGatewayInvokeAuth"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/POST/auth"
}

# --- Authorizer ----------------------------------------------------------------

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.main.id
  name             = "${var.project_name}-jwt"
  authorizer_type  = "REQUEST"
  authorizer_uri   = aws_lambda_function.authorizer.invoke_arn
  identity_sources = ["$request.header.Authorization"]

  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true

  # O resultado fica em cache por valor do header `Authorization`. Um token
  # expirado ou um segredo rotacionado continuam valendo até 5 minutos para
  # quem já foi autorizado — troca consciente por menos invocações da Lambda.
  authorizer_result_ttl_in_seconds = 300
}

resource "aws_lambda_permission" "api_gateway_authorizer" {
  statement_id  = "AllowAPIGatewayInvokeAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/authorizers/${aws_apigatewayv2_authorizer.jwt.id}"
}

# --- Rotas da API (só com NLB) -------------------------------------------------
#
# `for_each` sobre um mapa que vira `{}` e `count` nos singletons: com
# `api_nlb_hostname` vazio, nada daqui é criado.
#
# O NLB do `app-oficina` é `internet-facing`, então a integração é HTTP direto
# para o hostname, sem VPC Link. Consequência: o NLB continua alcançável por
# fora do gateway, e quem conhecer o hostname contorna o authorizer. Fechar isso
# (NLB interno + VPC Link) é o passo seguinte e depende do `infra-k8s`.

resource "aws_apigatewayv2_integration" "api_publica" {
  for_each = local.expor_api ? local.rotas_publicas : {}

  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = "${local.api_url}${each.value}"
}

resource "aws_apigatewayv2_route" "api_publica" {
  for_each = local.expor_api ? local.rotas_publicas : {}

  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.api_publica[each.key].id}"
}

# Todo o resto exige token. Sem `{proxy}` na URI: o `$default` não tem variável
# de caminho, então o gateway encaminha o caminho original para o destino.
resource "aws_apigatewayv2_integration" "api_protegida" {
  count = local.expor_api ? 1 : 0

  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = local.api_url
}

resource "aws_apigatewayv2_route" "api_protegida" {
  count = local.expor_api ? 1 : 0

  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "$default"
  target             = "integrations/${aws_apigatewayv2_integration.api_protegida[0].id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}
