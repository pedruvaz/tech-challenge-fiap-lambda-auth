import { cpfValido, normalizarCpf } from '../src/cpf';

describe('normalizarCpf', () => {
  it('remove pontuação', () => {
    expect(normalizarCpf('529.982.247-25')).toBe('52998224725');
  });

  it('mantém um CPF já limpo', () => {
    expect(normalizarCpf('52998224725')).toBe('52998224725');
  });
});

describe('cpfValido', () => {
  it.each(['529.982.247-25', '52998224725', '111.444.777-35'])(
    'aceita o CPF válido %s',
    (cpf) => {
      expect(cpfValido(cpf)).toBe(true);
    },
  );

  it('rejeita dígito verificador errado', () => {
    expect(cpfValido('529.982.247-26')).toBe(false);
  });

  it('rejeita tamanho diferente de 11 dígitos', () => {
    expect(cpfValido('5299822472')).toBe(false);
    expect(cpfValido('529982247251')).toBe(false);
  });

  // A pegadinha clássica: estes passam na fórmula do DV por construção.
  it.each(['00000000000', '11111111111', '22222222222', '99999999999'])(
    'rejeita a sequência repetida %s',
    (cpf) => {
      expect(cpfValido(cpf)).toBe(false);
    },
  );

  it('rejeita string vazia e texto', () => {
    expect(cpfValido('')).toBe(false);
    expect(cpfValido('abcdefghijk')).toBe(false);
  });
});
