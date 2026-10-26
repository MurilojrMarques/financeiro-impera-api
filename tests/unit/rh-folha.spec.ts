import { describe, expect, it } from 'vitest';
import { diasTrabalhadosNoMes, salarioProporcional } from '../../src/modules/rh/rh.service';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('folha proporcional (mês comercial de 30 dias)', () => {
  it('mês inteiro trabalhado = 30 dias (salário cheio), inclusive em fevereiro e em mês de 31 dias', () => {
    expect(diasTrabalhadosNoMes('2026-10', d('2026-01-05'), null)).toBe(30);
    expect(diasTrabalhadosNoMes('2026-02', d('2026-01-05'), null)).toBe(30);
    expect(diasTrabalhadosNoMes('2026-10', null, null)).toBe(30);
    expect(diasTrabalhadosNoMes('2026-10', d('2026-10-01'), d('2026-10-31'))).toBe(30);
  });

  it('entrou no meio do mês: dias corridos do início ao fim do mês, inclusive', () => {
    expect(diasTrabalhadosNoMes('2026-10', d('2026-10-10'), null)).toBe(22); // 10 a 31
    expect(diasTrabalhadosNoMes('2026-10', d('2026-10-31'), null)).toBe(1);
    expect(diasTrabalhadosNoMes('2026-02', d('2026-02-15'), null)).toBe(14); // 15 a 28
    expect(diasTrabalhadosNoMes('2026-10', d('2026-10-02'), null)).toBe(30); // 30 dias corridos: no máximo 30
  });

  it('saiu no meio do mês: do dia 1 até o dia da saída, inclusive', () => {
    expect(diasTrabalhadosNoMes('2026-10', d('2026-01-05'), d('2026-10-15'))).toBe(15);
    expect(diasTrabalhadosNoMes('2026-10', d('2026-01-05'), d('2026-10-01'))).toBe(1);
  });

  it('entrou e saiu no mesmo mês; fora do vínculo = 0', () => {
    expect(diasTrabalhadosNoMes('2026-10', d('2026-10-05'), d('2026-10-14'))).toBe(10);
    expect(diasTrabalhadosNoMes('2026-10', d('2026-11-01'), null)).toBe(0); // ainda não tinha entrado
    expect(diasTrabalhadosNoMes('2026-10', d('2026-01-01'), d('2026-09-30'))).toBe(0); // já tinha saído
  });

  it('salário ÷ 30 × dias, arredondado ao centavo', () => {
    expect(salarioProporcional(600000, 30)).toBe(600000);
    expect(salarioProporcional(600000, 15)).toBe(300000);
    expect(salarioProporcional(300000, 22)).toBe(220000);
    expect(salarioProporcional(250000, 14)).toBe(116667); // 1.166,666... → 1.166,67
    expect(salarioProporcional(600000, 0)).toBe(0);
  });
});
