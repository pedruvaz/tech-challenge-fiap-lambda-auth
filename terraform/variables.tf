variable "aws_region" {
  description = "Região da AWS. Precisa bater com a das outras stacks."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefixo e tag aplicados aos recursos."
  type        = string
  default     = "tech-challenge-fiap"
}

variable "timeout_seconds" {
  description = <<-EOT
    Timeout da função.

    O default de 3s da AWS não basta: no cold start a função cria a ENI na
    VPC, lê o segredo no Secrets Manager e abre a conexão TLS com o RDS antes
    da primeira consulta.
  EOT
  type        = number
  default     = 15
}

variable "memory_mb" {
  description = <<-EOT
    Memória da função — no Lambda, também define a fatia de CPU.

    256 MB é o ponto em que o parsing do JWT e o handshake TLS deixam de ser
    o gargalo. Subir mais não melhora, e o custo é por GB-segundo.
  EOT
  type        = number
  default     = 256
}

variable "log_retention_days" {
  description = "Retenção dos logs no CloudWatch. Sem isto o grupo nasce com retenção infinita."
  type        = number
  default     = 14
}
