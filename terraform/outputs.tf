output "lambda_function_name" {
  description = "Nome da função. Usado no `aws lambda update-function-code` do deploy."
  value       = aws_lambda_function.auth.function_name
}

output "lambda_function_arn" {
  description = "ARN da função — alvo da integração do API Gateway na rota POST /auth."
  value       = aws_lambda_function.auth.arn
}

output "lambda_invoke_arn" {
  description = <<-EOT
    ARN de invocação, no formato que a integração do API Gateway espera.

    É este, e não o `arn` simples, que vai no `integration_uri` da rota
    `POST /auth` — trocar os dois é um erro comum e o sintoma é 500 no
    Gateway sem nenhum log na função.
  EOT
  value       = aws_lambda_function.auth.invoke_arn
}

output "lambda_role_arn" {
  description = "Role de execução da função."
  value       = aws_iam_role.lambda.arn
}

output "log_group_name" {
  description = "Log group no CloudWatch — origem dos logs enviados ao Datadog."
  value       = aws_cloudwatch_log_group.lambda.name
}
