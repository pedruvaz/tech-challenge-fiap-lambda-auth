/**
 * Validação de CPF.
 *
 * O cálculo dos dois dígitos verificadores roda antes de qualquer consulta ao
 * banco: um CPF malformado é rejeitado de graça, sem abrir conexão. Numa
 * função serverless isso importa mais do que parece — conexão com o RDS é o
 * recurso caro aqui, e o /auth é rota pública.
 */

/** Remove tudo que não for dígito. Aceita `123.456.789-09` e `12345678909`. */
export function normalizarCpf(entrada: string): string {
  return entrada.replace(/\D/g, '');
}

/**
 * Valida os dois dígitos verificadores do CPF.
 *
 * Rejeita também as sequências de dígitos repetidos (`111.111.111-11` e
 * companhia): elas passam no cálculo do DV por construção, mas não são CPFs
 * válidos. É a pegadinha clássica de quem implementa só a fórmula.
 */
export function cpfValido(entrada: string): boolean {
  const cpf = normalizarCpf(entrada);

  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digitoVerificador = (ateIndice: number): number => {
    let soma = 0;
    let peso = ateIndice + 1;

    for (let i = 0; i < ateIndice; i += 1) {
      soma += Number(cpf[i]) * peso;
      peso -= 1;
    }

    const resto = (soma * 10) % 11;
    // Resto 10 e 11 valem 0 — definição da Receita Federal.
    return resto >= 10 ? 0 : resto;
  };

  return (
    digitoVerificador(9) === Number(cpf[9]) &&
    digitoVerificador(10) === Number(cpf[10])
  );
}
